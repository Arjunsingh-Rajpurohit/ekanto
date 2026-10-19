/**
 * Meeting points, on two separate networks so one network failing never stops a call.
 * Each only ever passes along sealed messages (encrypted and signed with the link's key):
 * it cannot read them, change them, or make up its own.
 */
export const MQTT_RELAYS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

export const NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://offchain.pub',
];

export const ALL_RELAYS = [...MQTT_RELAYS, ...NOSTR_RELAYS];

/**
 * Where rings go: a fixed few, so the Android app's quiet background listener and every caller
 * meet on the same ones. Two networks again, two operators each.
 */
export const RING_MQTT = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
export const RING_NOSTR = ['wss://nos.lol', 'wss://relay.damus.io'];
