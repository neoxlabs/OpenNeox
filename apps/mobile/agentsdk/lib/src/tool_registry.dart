/// tool_registry.dart — 工具注册表.
library;

import 'types.dart';

class ToolRegistry {
  ToolRegistry([List<AgentTool> initial = const []]) {
    for (final t in initial) {
      register(t);
    }
  }

  final Map<String, AgentTool> _tools = {};

  void register(AgentTool tool) {
    final name = tool.spec.name;
    if (_tools.containsKey(name)) {
      throw ArgumentError('tool "$name" already registered');
    }
    _tools[name] = tool;
  }

  void unregister(String name) => _tools.remove(name);

  AgentTool? find(String name) => _tools[name];

  List<ToolSpec> get specs =>
      _tools.values.map((t) => t.spec).toList(growable: false);

  bool get isEmpty => _tools.isEmpty;
  int get length => _tools.length;
}
