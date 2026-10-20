import { describe, expect, it } from 'vitest';
import { REC_WIRE_PREFIX, parseRecording, recordingNotice, recordingWire } from './protect';

describe('protected call: "tried to record" signal', () => {
  it('what one phone sends is what the others read', () => {
    const wire = recordingWire(true);
    expect(wire.startsWith(REC_WIRE_PREFIX)).toBe(true);
    expect(parseRecording(JSON.parse(wire))).toBe(true);
    expect(parseRecording(JSON.parse(recordingWire(false)))).toBe(false);
  });

  it('anything else is not a recording signal', () => {
    expect(parseRecording({ k: 'chan', cs: 'x' })).toBeNull();
    expect(parseRecording({ k: 'rec' })).toBeNull();
    expect(parseRecording({ k: 'rec', on: 'yes' })).toBeNull();
  });

  it('names the phone that tried, in plain words', () => {
    expect(recordingNotice('Ravi')).toBe("Ravi's phone tried to record — blocked.");
    expect(recordingNotice('')).toBe("Someone's phone tried to record — blocked.");
    expect(recordingNotice('x'.repeat(40))).toHaveLength(30 + "'s phone tried to record — blocked.".length);
  });
});
