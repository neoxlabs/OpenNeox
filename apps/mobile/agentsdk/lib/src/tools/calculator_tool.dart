/// calculator_tool.dart — 精确算术 (模型心算易错).
///
/// 自带递归下降解析器 — 零依赖, 支持 + - * / % ^ 括号、一元负号、
/// 常用函数 (sqrt/abs/round/floor/ceil/min/max/pow) 和常量 pi/e.
library;

import 'dart:math' as math;

import '../types.dart';

class CalculatorTool implements AgentTool {
  @override
  ToolSpec get spec => const ToolSpec(
        name: 'calculator',
        description: '精确计算算术表达式。支持 + - * / % ^ 括号、sqrt/abs/round/floor/ceil/'
            'min/max/pow 函数和 pi/e 常量。涉及数字计算时用它, 不要心算。',
        parameters: {
          'type': 'object',
          'properties': {
            'expression': {
              'type': 'string',
              'description': '如 "(12.5 * 8 + 3) / 7" 或 "sqrt(2) * pi"',
            },
          },
          'required': ['expression'],
        },
      );

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    final expr = (args['expression'] as String?)?.trim() ?? '';
    if (expr.isEmpty) return const ToolResult.error('expression 不能为空');
    try {
      final v = _Parser(expr).parse();
      /* 整数值不带小数点输出 */
      final out = (v == v.roundToDouble() && v.abs() < 1e15)
          ? v.round().toString()
          : v.toString();
      return ToolResult.ok('$expr = $out');
    } catch (e) {
      return ToolResult.error('表达式无法解析: $e');
    }
  }
}

/// 递归下降: expr := term (('+'|'-') term)*
///           term := factor (('*'|'/'|'%') factor)*
///           factor := unary ('^' factor)?          (右结合)
///           unary := '-' unary | primary
///           primary := number | const | func '(' expr (',' expr)* ')' | '(' expr ')'
class _Parser {
  _Parser(this.src);
  final String src;
  int _pos = 0;

  double parse() {
    final v = _expr();
    _skipWs();
    if (_pos < src.length) {
      throw FormatException('位置 $_pos 有多余字符 "${src[_pos]}"');
    }
    return v;
  }

  double _expr() {
    var v = _term();
    while (true) {
      _skipWs();
      if (_peek() == '+') {
        _pos++;
        v += _term();
      } else if (_peek() == '-') {
        _pos++;
        v -= _term();
      } else {
        return v;
      }
    }
  }

  double _term() {
    var v = _factor();
    while (true) {
      _skipWs();
      final c = _peek();
      if (c == '*') {
        _pos++;
        v *= _factor();
      } else if (c == '/') {
        _pos++;
        v /= _factor();
      } else if (c == '%') {
        _pos++;
        v = v % _factor();
      } else {
        return v;
      }
    }
  }

  double _factor() {
    final base = _unary();
    _skipWs();
    if (_peek() == '^') {
      _pos++;
      return math.pow(base, _factor()).toDouble();
    }
    return base;
  }

  double _unary() {
    _skipWs();
    if (_peek() == '-') {
      _pos++;
      return -_unary();
    }
    return _primary();
  }

  double _primary() {
    _skipWs();
    final c = _peek();
    if (c == '(') {
      _pos++;
      final v = _expr();
      _expect(')');
      return v;
    }
    if (_isDigit(c) || c == '.') return _number();
    if (_isAlpha(c)) return _identifier();
    throw FormatException('位置 $_pos 意外字符 "$c"');
  }

  double _number() {
    final start = _pos;
    while (_pos < src.length &&
        (_isDigit(src[_pos]) || src[_pos] == '.' || src[_pos] == 'e' ||
            src[_pos] == 'E' ||
            ((src[_pos] == '+' || src[_pos] == '-') &&
                _pos > start &&
                (src[_pos - 1] == 'e' || src[_pos - 1] == 'E')))) {
      _pos++;
    }
    final s = src.substring(start, _pos);
    final v = double.tryParse(s);
    if (v == null) throw FormatException('无效数字 "$s"');
    return v;
  }

  double _identifier() {
    final start = _pos;
    while (_pos < src.length && (_isAlpha(src[_pos]) || _isDigit(src[_pos]))) {
      _pos++;
    }
    final name = src.substring(start, _pos).toLowerCase();
    switch (name) {
      case 'pi':
        return math.pi;
      case 'e':
        return math.e;
    }
    _expect('(');
    final argValues = <double>[_expr()];
    _skipWs();
    while (_peek() == ',') {
      _pos++;
      argValues.add(_expr());
      _skipWs();
    }
    _expect(')');
    final a = argValues[0];
    switch (name) {
      case 'sqrt':
        return math.sqrt(a);
      case 'abs':
        return a.abs();
      case 'round':
        return a.roundToDouble();
      case 'floor':
        return a.floorToDouble();
      case 'ceil':
        return a.ceilToDouble();
      case 'min':
        return argValues.reduce(math.min);
      case 'max':
        return argValues.reduce(math.max);
      case 'pow':
        if (argValues.length != 2) {
          throw const FormatException('pow 需要 2 个参数');
        }
        return math.pow(a, argValues[1]).toDouble();
      default:
        throw FormatException('未知函数 "$name"');
    }
  }

  void _expect(String c) {
    _skipWs();
    if (_peek() != c) {
      throw FormatException('位置 $_pos 期望 "$c"');
    }
    _pos++;
  }

  String _peek() => _pos < src.length ? src[_pos] : '';

  void _skipWs() {
    while (_pos < src.length && (src[_pos] == ' ' || src[_pos] == '\t')) {
      _pos++;
    }
  }

  bool _isDigit(String c) =>
      c.isNotEmpty && c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57;
  bool _isAlpha(String c) {
    if (c.isEmpty) return false;
    final u = c.codeUnitAt(0);
    return (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || c == '_';
  }
}
