import 'package:flutter_test/flutter_test.dart';

/// Mirrors session_router._normalizeApprovalMode — keep in sync.
String normalizeApprovalMode(String raw) {
  switch (raw.trim().toLowerCase()) {
    case 'yolo':
    case 'dangerous':
      return 'dangerous';
    case 'plan':
    case 'manual':
      return 'manual';
    case 'auto':
    default:
      return 'auto';
  }
}

void main() {
  test('Plan/YOLO wire values survive normalization', () {
    expect(normalizeApprovalMode('manual'), 'manual');
    expect(normalizeApprovalMode('plan'), 'manual');
    expect(normalizeApprovalMode('dangerous'), 'dangerous');
    expect(normalizeApprovalMode('yolo'), 'dangerous');
    expect(normalizeApprovalMode('auto'), 'auto');
    expect(normalizeApprovalMode('garbage'), 'auto');
  });
}
