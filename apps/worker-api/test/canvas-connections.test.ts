import { describe, expect, it } from 'vitest';
import {
  nextCanvasConnectionStatus,
  nextCanvasToolFailureStatus,
} from '../src/services/canvas-connections';

describe('Canvas connection recovery', () => {
  it('keeps the first rejected session available for one automatic retry', () => {
    expect(nextCanvasConnectionStatus('connected', 'session_expired')).toBe('suspect');
  });

  it('requires reconnection after a second rejected session', () => {
    expect(nextCanvasConnectionStatus('suspect', 'session_expired')).toBe('expired');
  });

  it('does not treat a permission response as proof that the session expired', () => {
    expect(nextCanvasConnectionStatus('connected', 'permission_denied')).toBe('connected');
    expect(nextCanvasConnectionStatus('suspect', 'permission_denied')).toBe('suspect');
  });

  it('expires structurally invalid or missing cookie sets immediately', () => {
    expect(nextCanvasConnectionStatus('connected', 'invalid_connection')).toBe('expired');
    expect(nextCanvasConnectionStatus('connected', 'not_connected')).toBe('expired');
  });

  it('does not let repeated tool failures expire a connection without explicit validation', () => {
    expect(nextCanvasToolFailureStatus('connected', 'session_expired')).toBe('suspect');
    expect(nextCanvasToolFailureStatus('suspect', 'session_expired')).toBe('suspect');
  });
});
