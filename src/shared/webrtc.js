/**
 * One WebRTC call with a BTicino intercom, for both cards in this repository.
 *
 * The exchange is the one bticino_ha_extras proved against the BNC1 firmware,
 * and the three things that look odd are the three that matter:
 *
 *  - the audio transceiver always sends real RTP, silence when the microphone
 *    is off, because the device opens its own microphone only once packets
 *    actually arrive - an SDP direction of sendrecv is not enough;
 *  - video is offered only to units that have a camera, so a Call Home to the
 *    indoor monitor negotiates audio alone instead of collecting a rejected
 *    m-section;
 *  - signalling runs over its own WebSocket, because camera/webrtc/offer
 *    answers with a stream of events (session, answer, candidate) rather than
 *    a single result.
 *
 * The caller gets a MediaStream, a state and two callbacks: `onState` for what
 * the card draws, `onNotice` for what the user should be told. Everything the
 * device needs and the user never sees stays in here.
 */

export const CALL_STATE = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  CLOSED: 'closed',
};

const DOMAIN = 'bticino_intercom';

const SIGNALING_TIMEOUT = 15000;
const RECONNECT_DELAY = 2000;
const MAX_RECONNECTS = 3;

/** Chromium is the only engine the device's firmware negotiates correctly. */
export const isChromium = () => {
  const ua = navigator.userAgent;
  if (/Firefox|FxiOS/i.test(ua)) return false;
  if (/Edg\/|Chrome\/|CriOS/i.test(ua) && !/OPR\//i.test(ua)) return true;
  return !/Safari/i.test(ua);
};

export class BticinoCallSession {
  constructor(hass, { entityId, wantsVideo, autoMic = true, maxReconnects = MAX_RECONNECTS, onState, onNotice }) {
    this.hass = hass;
    this.entityId = entityId;
    this.wantsVideo = !!wantsVideo;
    // asking for the microphone up front costs a prompt; a card whose own
    // option says not to can leave it to the button
    this.autoMic = autoMic !== false;
    this.maxReconnects = maxReconnects;
    this.onState = onState || (() => {});
    // something the user should read, rather than a state the card draws
    this.onNotice = onNotice || (() => {});
    this.stream = new MediaStream();
    this.state = CALL_STATE.CONNECTING;
    this.micActive = false;
    this.error = null;
    this._wanted = true;
    this._reconnects = 0;
    this._candidateId = 100;
    this._pendingCandidates = [];
    this._accepted = false;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onState(this);
  }

  async start() {
    this._audioCtx = new AudioContext();
    // Asking once up front means the first words are not lost to a prompt.
    if (this.autoMic && window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
      try {
        this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        this._micStream = null;
      }
    }
    await this._connect();
  }

  async _connect() {
    this._set(this._reconnects ? CALL_STATE.RECONNECTING : CALL_STATE.CONNECTING);
    const keepMic = this._micStream;
    this._micStream = null;
    this._closeConnection();
    this._micStream = keepMic;

    try {
      if (this._audioCtx?.state === 'suspended') await this._audioCtx.resume();
      const oscillator = this._audioCtx.createOscillator();
      oscillator.frequency.value = 0;
      const destination = this._audioCtx.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      this._oscillator = oscillator;
      this._silenceStream = destination.stream;
      this._silenceTrack = this._silenceStream.getAudioTracks()[0];

      this._pc = new RTCPeerConnection({
        iceServers: await this._iceServers(),
        rtcpMuxPolicy: 'require',
      });

      const micTrack = this._micStream?.getAudioTracks()?.[0];
      this._pc.addTransceiver(micTrack || this._silenceTrack, {
        direction: 'sendrecv',
        streams: [this._silenceStream],
      });
      if (this.wantsVideo) this._pc.addTransceiver('video', { direction: 'recvonly' });
      if (micTrack) {
        this._micSender = this._pc.getSenders().find((sender) => sender.track?.kind === 'audio');
        this.micActive = true;
      }

      this.stream = new MediaStream();
      this._pc.ontrack = (event) => {
        this.stream.addTrack(event.track);
        this.onState(this);
      };
      this._pc.onconnectionstatechange = () => {
        const state = this._pc?.connectionState;
        if (state === 'connected') {
          this._reconnects = 0;
          this._accept();
          this._set(CALL_STATE.LIVE);
        } else if (this._wanted && ['disconnected', 'failed', 'closed'].includes(state)) {
          this._scheduleReconnect();
        }
      };
      this._pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const candidate = {
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid,
        };
        if (this._ws?.readyState === WebSocket.OPEN && this._sessionId) this._sendCandidate(candidate);
        else this._pendingCandidates.push(candidate);
      };

      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      await this._signal(this._pc.localDescription.sdp);
    } catch (err) {
      if (this._wanted) this._set(CALL_STATE.ERROR, err?.message || String(err));
    }
  }

  async _iceServers() {
    const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const config = await this.hass.callWS({
        type: 'camera/webrtc/get_client_config',
        entity_id: this.entityId,
      });
      const servers = config?.configuration?.iceServers;
      if (!servers?.length) return fallback;
      // TCP relays and turns: never complete with this device
      const usable = servers
        .map((server) => {
          const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
            (url) => !url.includes('transport=tcp') && !url.startsWith('turns:'),
          );
          return urls.length ? { ...server, urls } : null;
        })
        .filter(Boolean);
      return usable.length ? usable : fallback;
    } catch {
      return fallback;
    }
  }

  _signal(offerSdp) {
    return new Promise((resolve, reject) => {
      const token = this.hass.auth?.data?.access_token || this.hass.connection?.options?.auth?.data?.access_token;
      if (!token) {
        reject(new Error('no access token'));
        return;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/api/websocket`);
      this._ws = socket;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._signalTimer);
        this._signalTimer = null;
        if (err) reject(err);
        else resolve();
      };

      this._signalTimer = setTimeout(() => finish(new Error('signaling timeout')), SIGNALING_TIMEOUT);
      socket.onerror = () => finish(new Error('signaling socket error'));
      socket.onclose = () => finish(new Error('signaling socket closed'));
      socket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'auth_required') {
          socket.send(JSON.stringify({ type: 'auth', access_token: token }));
          return;
        }
        if (message.type === 'auth_ok') {
          socket.send(
            JSON.stringify({ id: 1, type: 'camera/webrtc/offer', entity_id: this.entityId, offer: offerSdp }),
          );
          return;
        }
        if (message.type === 'auth_invalid') {
          finish(new Error('authentication failed'));
          return;
        }
        if (message.type === 'result' && !message.success) {
          finish(new Error(message.error?.message || 'offer rejected'));
          return;
        }
        if (message.type !== 'event') return;

        const event_ = message.event;
        if (event_.type === 'session') {
          this._sessionId = event_.session_id;
          for (const candidate of this._pendingCandidates) this._sendCandidate(candidate);
          this._pendingCandidates = [];
        } else if (event_.type === 'answer') {
          try {
            await this._pc.setRemoteDescription({ type: 'answer', sdp: event_.answer });
            finish();
          } catch (err) {
            finish(err);
          }
        } else if (event_.type === 'candidate' && event_.candidate) {
          try {
            await this._pc.addIceCandidate({
              candidate: event_.candidate.candidate,
              sdpMLineIndex: event_.candidate.sdp_m_line_index ?? event_.candidate.sdpMLineIndex ?? 0,
            });
          } catch {
            /* a candidate we cannot use is not fatal */
          }
        } else if (event_.type === 'error') {
          finish(new Error(event_.message || 'signaling error'));
        }
      };
    });
  }

  _sendCandidate(candidate) {
    this._candidateId += 1;
    this._ws.send(
      JSON.stringify({
        id: this._candidateId,
        type: 'camera/webrtc/candidate',
        entity_id: this.entityId,
        session_id: this._sessionId,
        candidate,
      }),
    );
  }

  /**
   * Answering a ring takes one message more than the handshake: the device
   * stays silent until the session is told to unmute, and that message is a
   * toggle, so it has to be sent exactly once per call
   * (k-the-hidden-hero/bticino_intercom#72).
   *
   * Only the integration knows whether this session answered a ring or opened
   * a view nobody was called for, so the card reports the one thing it alone
   * knows - the peer connection is up - and leaves the decision there. An
   * integration without the service simply has nothing to unmute.
   */
  _accept() {
    if (this._accepted) return;
    this._accepted = true;
    if (!this.hass.services?.[DOMAIN]?.accept_call) return;
    this.hass.callService(DOMAIN, 'accept_call', { entity_id: this.entityId }).catch(() => {
      /* the call is up either way; this only decides whether it can talk */
    });
  }

  _scheduleReconnect() {
    if (!this._wanted || this._reconnectTimer) return;
    this._reconnects += 1;
    if (this._reconnects > this.maxReconnects) {
      this._set(CALL_STATE.ERROR, 'connection lost');
      return;
    }
    this._set(CALL_STATE.RECONNECTING);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wanted) this._connect();
    }, RECONNECT_DELAY);
  }

  /** Swap the silence the device needs for the real microphone, and back. */
  async setMic(on) {
    if (on === this.micActive) return;
    if (on) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        this.onNotice('mic_insecure');
        return;
      }
      try {
        if (this._audioCtx?.state === 'suspended') await this._audioCtx.resume();
        this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = this._micStream.getAudioTracks()[0];
        const sender = this._pc?.getSenders()?.find((item) => item.track?.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(track);
          this._micSender = sender;
        }
        this.micActive = true;
      } catch {
        // a denial is silent otherwise, and the user keeps pressing the button
        this.micActive = false;
        this.onNotice('mic_denied');
      }
    } else {
      if (this._micSender && this._silenceTrack) await this._micSender.replaceTrack(this._silenceTrack);
      this._stopMicStream();
      this.micActive = false;
    }
    this.onState(this);
  }

  _stopMicStream() {
    if (!this._micStream) return;
    for (const track of this._micStream.getTracks()) track.stop();
    this._micStream = null;
  }

  _closeConnection() {
    this._stopMicStream();
    if (this._signalTimer) {
      clearTimeout(this._signalTimer);
      this._signalTimer = null;
    }
    if (this._pc) {
      this._pc.ontrack = null;
      this._pc.onconnectionstatechange = null;
      this._pc.onicecandidate = null;
      try {
        this._pc.close();
      } catch {
        /* already gone */
      }
      this._pc = null;
    }
    if (this._ws) {
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      try {
        this._ws.close();
      } catch {
        /* already gone */
      }
      this._ws = null;
    }
    if (this._oscillator) {
      try {
        this._oscillator.stop();
      } catch {
        /* already stopped */
      }
      this._oscillator = null;
    }
    this._micSender = null;
    this._silenceTrack = null;
    this._silenceStream = null;
    this._sessionId = null;
    this._pendingCandidates = [];
  }

  stop() {
    this._wanted = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._closeConnection();
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch {
        /* already closed */
      }
      this._audioCtx = null;
    }
    this.micActive = false;
    this._set(CALL_STATE.CLOSED);
  }
}
