// Answering a ring needs one `player`/`unmute` over the signaling session, and
// exactly one: a second mutes the call again in both directions
// (k-the-hidden-hero/bticino_intercom#72). The card cannot tell an answered
// ring from a view it opened itself, so it reports the connection and lets the
// integration decide - which means the report must be sent once per call, and
// only where there is something on the other end to receive it.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.MediaStream = class {
  addTrack() {}
  getAudioTracks() {
    return [];
  }
  getVideoTracks() {
    return [];
  }
};

const { BticinoCallSession } = await import('../src/shared/webrtc.js');

function fakeHass({ withService }) {
  const calls = [];
  return {
    calls,
    services: withService ? { bticino_intercom: { accept_call: {} } } : { bticino_intercom: { reject_call: {} } },
    callService: (domain, service, data) => {
      calls.push({ domain, service, data });
      return Promise.resolve();
    },
  };
}

const session = (hass) => new BticinoCallSession(hass, { entityId: 'camera.front_door', wantsVideo: true });

test('a connected call is reported once, whatever happens after', () => {
  const hass = fakeHass({ withService: true });
  const call = session(hass);

  call._accept();
  call._accept();
  call._accept();

  assert.deepEqual(hass.calls, [
    { domain: 'bticino_intercom', service: 'accept_call', data: { entity_id: 'camera.front_door' } },
  ]);
});

test('an integration without the service is left alone', () => {
  const hass = fakeHass({ withService: false });
  const call = session(hass);

  call._accept();

  assert.deepEqual(hass.calls, []);
});

test('a service that rejects does not take the call down with it', async () => {
  const hass = fakeHass({ withService: true });
  hass.callService = () => Promise.reject(new Error('no call to accept'));
  const call = session(hass);

  call._accept();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(call.error, null);
});

test('each call reports for itself', () => {
  const hass = fakeHass({ withService: true });

  session(hass)._accept();
  session(hass)._accept();

  assert.equal(hass.calls.length, 2);
});
