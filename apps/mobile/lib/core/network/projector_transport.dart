/// projector_transport.dart — Phone timeline projector ↔ WS transport hook.
///
/// TimelineState must not import [ws_client_provider] (circular: WS applies
/// into TimelineState). Transport re-attach is registered here once WS boots.
///
/// Architecture: quiet re-attach is **transport recovery** when Execution=running
/// but the event pipe went silent — not a phone-side business idle guess.
library;

typedef AttachOrCatchUp = Future<void> Function(String sessionId);

AttachOrCatchUp? _attachOrCatchUp;

void bindProjectorAttachOrCatchUp(AttachOrCatchUp fn) {
  _attachOrCatchUp = fn;
}

Future<void> projectorAttachOrCatchUp(String sessionId) async {
  final fn = _attachOrCatchUp;
  if (fn == null) return;
  await fn(sessionId);
}
