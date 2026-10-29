// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'database.dart';

// ignore_for_file: type=lint
class $PairedDesktopsTable extends PairedDesktops
    with TableInfo<$PairedDesktopsTable, PairedDesktop> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $PairedDesktopsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _deviceIdMeta = const VerificationMeta(
    'deviceId',
  );
  @override
  late final GeneratedColumn<String> deviceId = GeneratedColumn<String>(
    'device_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways('UNIQUE'),
  );
  static const VerificationMeta _deviceNameMeta = const VerificationMeta(
    'deviceName',
  );
  @override
  late final GeneratedColumn<String> deviceName = GeneratedColumn<String>(
    'device_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastSeenLanIpMeta = const VerificationMeta(
    'lastSeenLanIp',
  );
  @override
  late final GeneratedColumn<String> lastSeenLanIp = GeneratedColumn<String>(
    'last_seen_lan_ip',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastSeenLanPortMeta = const VerificationMeta(
    'lastSeenLanPort',
  );
  @override
  late final GeneratedColumn<int> lastSeenLanPort = GeneratedColumn<int>(
    'last_seen_lan_port',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _desktopPubkeyMeta = const VerificationMeta(
    'desktopPubkey',
  );
  @override
  late final GeneratedColumn<Uint8List> desktopPubkey =
      GeneratedColumn<Uint8List>(
        'desktop_pubkey',
        aliasedName,
        true,
        type: DriftSqlType.blob,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _relaySessionKeyMeta = const VerificationMeta(
    'relaySessionKey',
  );
  @override
  late final GeneratedColumn<Uint8List> relaySessionKey =
      GeneratedColumn<Uint8List>(
        'relay_session_key',
        aliasedName,
        true,
        type: DriftSqlType.blob,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _deviceTokenMeta = const VerificationMeta(
    'deviceToken',
  );
  @override
  late final GeneratedColumn<String> deviceToken = GeneratedColumn<String>(
    'device_token',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _pairedAtMeta = const VerificationMeta(
    'pairedAt',
  );
  @override
  late final GeneratedColumn<int> pairedAt = GeneratedColumn<int>(
    'paired_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _lastConnectedAtMeta = const VerificationMeta(
    'lastConnectedAt',
  );
  @override
  late final GeneratedColumn<int> lastConnectedAt = GeneratedColumn<int>(
    'last_connected_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastAnnounceAtMeta = const VerificationMeta(
    'lastAnnounceAt',
  );
  @override
  late final GeneratedColumn<int> lastAnnounceAt = GeneratedColumn<int>(
    'last_announce_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    deviceId,
    deviceName,
    lastSeenLanIp,
    lastSeenLanPort,
    desktopPubkey,
    relaySessionKey,
    deviceToken,
    pairedAt,
    lastConnectedAt,
    lastAnnounceAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'paired_desktops';
  @override
  VerificationContext validateIntegrity(
    Insertable<PairedDesktop> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('device_id')) {
      context.handle(
        _deviceIdMeta,
        deviceId.isAcceptableOrUnknown(data['device_id']!, _deviceIdMeta),
      );
    } else if (isInserting) {
      context.missing(_deviceIdMeta);
    }
    if (data.containsKey('device_name')) {
      context.handle(
        _deviceNameMeta,
        deviceName.isAcceptableOrUnknown(data['device_name']!, _deviceNameMeta),
      );
    }
    if (data.containsKey('last_seen_lan_ip')) {
      context.handle(
        _lastSeenLanIpMeta,
        lastSeenLanIp.isAcceptableOrUnknown(
          data['last_seen_lan_ip']!,
          _lastSeenLanIpMeta,
        ),
      );
    }
    if (data.containsKey('last_seen_lan_port')) {
      context.handle(
        _lastSeenLanPortMeta,
        lastSeenLanPort.isAcceptableOrUnknown(
          data['last_seen_lan_port']!,
          _lastSeenLanPortMeta,
        ),
      );
    }
    if (data.containsKey('desktop_pubkey')) {
      context.handle(
        _desktopPubkeyMeta,
        desktopPubkey.isAcceptableOrUnknown(
          data['desktop_pubkey']!,
          _desktopPubkeyMeta,
        ),
      );
    }
    if (data.containsKey('relay_session_key')) {
      context.handle(
        _relaySessionKeyMeta,
        relaySessionKey.isAcceptableOrUnknown(
          data['relay_session_key']!,
          _relaySessionKeyMeta,
        ),
      );
    }
    if (data.containsKey('device_token')) {
      context.handle(
        _deviceTokenMeta,
        deviceToken.isAcceptableOrUnknown(
          data['device_token']!,
          _deviceTokenMeta,
        ),
      );
    }
    if (data.containsKey('paired_at')) {
      context.handle(
        _pairedAtMeta,
        pairedAt.isAcceptableOrUnknown(data['paired_at']!, _pairedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_pairedAtMeta);
    }
    if (data.containsKey('last_connected_at')) {
      context.handle(
        _lastConnectedAtMeta,
        lastConnectedAt.isAcceptableOrUnknown(
          data['last_connected_at']!,
          _lastConnectedAtMeta,
        ),
      );
    }
    if (data.containsKey('last_announce_at')) {
      context.handle(
        _lastAnnounceAtMeta,
        lastAnnounceAt.isAcceptableOrUnknown(
          data['last_announce_at']!,
          _lastAnnounceAtMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  PairedDesktop map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return PairedDesktop(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      deviceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}device_id'],
      )!,
      deviceName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}device_name'],
      ),
      lastSeenLanIp: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_seen_lan_ip'],
      ),
      lastSeenLanPort: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_seen_lan_port'],
      ),
      desktopPubkey: attachedDatabase.typeMapping.read(
        DriftSqlType.blob,
        data['${effectivePrefix}desktop_pubkey'],
      ),
      relaySessionKey: attachedDatabase.typeMapping.read(
        DriftSqlType.blob,
        data['${effectivePrefix}relay_session_key'],
      ),
      deviceToken: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}device_token'],
      ),
      pairedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}paired_at'],
      )!,
      lastConnectedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_connected_at'],
      ),
      lastAnnounceAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_announce_at'],
      ),
    );
  }

  @override
  $PairedDesktopsTable createAlias(String alias) {
    return $PairedDesktopsTable(attachedDatabase, alias);
  }
}

class PairedDesktop extends DataClass implements Insertable<PairedDesktop> {
  final int id;
  final String deviceId;
  final String? deviceName;
  final String? lastSeenLanIp;
  final int? lastSeenLanPort;

  /// X25519 公钥, 32 bytes
  final Uint8List? desktopPubkey;

  /// 派生的 AES-256 session key.
  /// **生产**: key 应该存 flutter_secure_storage, 这里只缓存指针/标识.
  /// MVP 阶段先直接放 db 字段, Phase 2/3 接通时迁移到 secure storage.
  final Uint8List? relaySessionKey;

  /// Desktop 颁发的长期 device token (跨 mode 复用)
  final String? deviceToken;
  final int pairedAt;
  final int? lastConnectedAt;

  /// 服务端记录的"这台电脑最后一次上报存活"时间 (/api/v1/devices/my 的
  /// last_announce_at)。
  ///
  /// 2026-08-09 加。在此之前这个字段**服务端一直在给, 客户端一直扔掉** ——
  /// 于是"连哪台"只能靠 lastConnectedAt ("我上次连过谁")。真机实测的后果:
  /// 账号下同一台 Mac 因为改过名/重装留了两条记录, 手机自动连的是那台早就死掉的
  /// (它碰巧有更晚的 lastConnectedAt), 而两分钟前还在 announce 的那台被跳过,
  /// 用户看到的是"电脑明明开着却连不上"。
  /// 谁还活着是服务端知道的事实, 不该靠客户端的历史记忆去猜。
  final int? lastAnnounceAt;
  const PairedDesktop({
    required this.id,
    required this.deviceId,
    this.deviceName,
    this.lastSeenLanIp,
    this.lastSeenLanPort,
    this.desktopPubkey,
    this.relaySessionKey,
    this.deviceToken,
    required this.pairedAt,
    this.lastConnectedAt,
    this.lastAnnounceAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['device_id'] = Variable<String>(deviceId);
    if (!nullToAbsent || deviceName != null) {
      map['device_name'] = Variable<String>(deviceName);
    }
    if (!nullToAbsent || lastSeenLanIp != null) {
      map['last_seen_lan_ip'] = Variable<String>(lastSeenLanIp);
    }
    if (!nullToAbsent || lastSeenLanPort != null) {
      map['last_seen_lan_port'] = Variable<int>(lastSeenLanPort);
    }
    if (!nullToAbsent || desktopPubkey != null) {
      map['desktop_pubkey'] = Variable<Uint8List>(desktopPubkey);
    }
    if (!nullToAbsent || relaySessionKey != null) {
      map['relay_session_key'] = Variable<Uint8List>(relaySessionKey);
    }
    if (!nullToAbsent || deviceToken != null) {
      map['device_token'] = Variable<String>(deviceToken);
    }
    map['paired_at'] = Variable<int>(pairedAt);
    if (!nullToAbsent || lastConnectedAt != null) {
      map['last_connected_at'] = Variable<int>(lastConnectedAt);
    }
    if (!nullToAbsent || lastAnnounceAt != null) {
      map['last_announce_at'] = Variable<int>(lastAnnounceAt);
    }
    return map;
  }

  PairedDesktopsCompanion toCompanion(bool nullToAbsent) {
    return PairedDesktopsCompanion(
      id: Value(id),
      deviceId: Value(deviceId),
      deviceName: deviceName == null && nullToAbsent
          ? const Value.absent()
          : Value(deviceName),
      lastSeenLanIp: lastSeenLanIp == null && nullToAbsent
          ? const Value.absent()
          : Value(lastSeenLanIp),
      lastSeenLanPort: lastSeenLanPort == null && nullToAbsent
          ? const Value.absent()
          : Value(lastSeenLanPort),
      desktopPubkey: desktopPubkey == null && nullToAbsent
          ? const Value.absent()
          : Value(desktopPubkey),
      relaySessionKey: relaySessionKey == null && nullToAbsent
          ? const Value.absent()
          : Value(relaySessionKey),
      deviceToken: deviceToken == null && nullToAbsent
          ? const Value.absent()
          : Value(deviceToken),
      pairedAt: Value(pairedAt),
      lastConnectedAt: lastConnectedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastConnectedAt),
      lastAnnounceAt: lastAnnounceAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastAnnounceAt),
    );
  }

  factory PairedDesktop.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return PairedDesktop(
      id: serializer.fromJson<int>(json['id']),
      deviceId: serializer.fromJson<String>(json['deviceId']),
      deviceName: serializer.fromJson<String?>(json['deviceName']),
      lastSeenLanIp: serializer.fromJson<String?>(json['lastSeenLanIp']),
      lastSeenLanPort: serializer.fromJson<int?>(json['lastSeenLanPort']),
      desktopPubkey: serializer.fromJson<Uint8List?>(json['desktopPubkey']),
      relaySessionKey: serializer.fromJson<Uint8List?>(json['relaySessionKey']),
      deviceToken: serializer.fromJson<String?>(json['deviceToken']),
      pairedAt: serializer.fromJson<int>(json['pairedAt']),
      lastConnectedAt: serializer.fromJson<int?>(json['lastConnectedAt']),
      lastAnnounceAt: serializer.fromJson<int?>(json['lastAnnounceAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'deviceId': serializer.toJson<String>(deviceId),
      'deviceName': serializer.toJson<String?>(deviceName),
      'lastSeenLanIp': serializer.toJson<String?>(lastSeenLanIp),
      'lastSeenLanPort': serializer.toJson<int?>(lastSeenLanPort),
      'desktopPubkey': serializer.toJson<Uint8List?>(desktopPubkey),
      'relaySessionKey': serializer.toJson<Uint8List?>(relaySessionKey),
      'deviceToken': serializer.toJson<String?>(deviceToken),
      'pairedAt': serializer.toJson<int>(pairedAt),
      'lastConnectedAt': serializer.toJson<int?>(lastConnectedAt),
      'lastAnnounceAt': serializer.toJson<int?>(lastAnnounceAt),
    };
  }

  PairedDesktop copyWith({
    int? id,
    String? deviceId,
    Value<String?> deviceName = const Value.absent(),
    Value<String?> lastSeenLanIp = const Value.absent(),
    Value<int?> lastSeenLanPort = const Value.absent(),
    Value<Uint8List?> desktopPubkey = const Value.absent(),
    Value<Uint8List?> relaySessionKey = const Value.absent(),
    Value<String?> deviceToken = const Value.absent(),
    int? pairedAt,
    Value<int?> lastConnectedAt = const Value.absent(),
    Value<int?> lastAnnounceAt = const Value.absent(),
  }) => PairedDesktop(
    id: id ?? this.id,
    deviceId: deviceId ?? this.deviceId,
    deviceName: deviceName.present ? deviceName.value : this.deviceName,
    lastSeenLanIp: lastSeenLanIp.present
        ? lastSeenLanIp.value
        : this.lastSeenLanIp,
    lastSeenLanPort: lastSeenLanPort.present
        ? lastSeenLanPort.value
        : this.lastSeenLanPort,
    desktopPubkey: desktopPubkey.present
        ? desktopPubkey.value
        : this.desktopPubkey,
    relaySessionKey: relaySessionKey.present
        ? relaySessionKey.value
        : this.relaySessionKey,
    deviceToken: deviceToken.present ? deviceToken.value : this.deviceToken,
    pairedAt: pairedAt ?? this.pairedAt,
    lastConnectedAt: lastConnectedAt.present
        ? lastConnectedAt.value
        : this.lastConnectedAt,
    lastAnnounceAt: lastAnnounceAt.present
        ? lastAnnounceAt.value
        : this.lastAnnounceAt,
  );
  PairedDesktop copyWithCompanion(PairedDesktopsCompanion data) {
    return PairedDesktop(
      id: data.id.present ? data.id.value : this.id,
      deviceId: data.deviceId.present ? data.deviceId.value : this.deviceId,
      deviceName: data.deviceName.present
          ? data.deviceName.value
          : this.deviceName,
      lastSeenLanIp: data.lastSeenLanIp.present
          ? data.lastSeenLanIp.value
          : this.lastSeenLanIp,
      lastSeenLanPort: data.lastSeenLanPort.present
          ? data.lastSeenLanPort.value
          : this.lastSeenLanPort,
      desktopPubkey: data.desktopPubkey.present
          ? data.desktopPubkey.value
          : this.desktopPubkey,
      relaySessionKey: data.relaySessionKey.present
          ? data.relaySessionKey.value
          : this.relaySessionKey,
      deviceToken: data.deviceToken.present
          ? data.deviceToken.value
          : this.deviceToken,
      pairedAt: data.pairedAt.present ? data.pairedAt.value : this.pairedAt,
      lastConnectedAt: data.lastConnectedAt.present
          ? data.lastConnectedAt.value
          : this.lastConnectedAt,
      lastAnnounceAt: data.lastAnnounceAt.present
          ? data.lastAnnounceAt.value
          : this.lastAnnounceAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('PairedDesktop(')
          ..write('id: $id, ')
          ..write('deviceId: $deviceId, ')
          ..write('deviceName: $deviceName, ')
          ..write('lastSeenLanIp: $lastSeenLanIp, ')
          ..write('lastSeenLanPort: $lastSeenLanPort, ')
          ..write('desktopPubkey: $desktopPubkey, ')
          ..write('relaySessionKey: $relaySessionKey, ')
          ..write('deviceToken: $deviceToken, ')
          ..write('pairedAt: $pairedAt, ')
          ..write('lastConnectedAt: $lastConnectedAt, ')
          ..write('lastAnnounceAt: $lastAnnounceAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    deviceId,
    deviceName,
    lastSeenLanIp,
    lastSeenLanPort,
    $driftBlobEquality.hash(desktopPubkey),
    $driftBlobEquality.hash(relaySessionKey),
    deviceToken,
    pairedAt,
    lastConnectedAt,
    lastAnnounceAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is PairedDesktop &&
          other.id == this.id &&
          other.deviceId == this.deviceId &&
          other.deviceName == this.deviceName &&
          other.lastSeenLanIp == this.lastSeenLanIp &&
          other.lastSeenLanPort == this.lastSeenLanPort &&
          $driftBlobEquality.equals(other.desktopPubkey, this.desktopPubkey) &&
          $driftBlobEquality.equals(
            other.relaySessionKey,
            this.relaySessionKey,
          ) &&
          other.deviceToken == this.deviceToken &&
          other.pairedAt == this.pairedAt &&
          other.lastConnectedAt == this.lastConnectedAt &&
          other.lastAnnounceAt == this.lastAnnounceAt);
}

class PairedDesktopsCompanion extends UpdateCompanion<PairedDesktop> {
  final Value<int> id;
  final Value<String> deviceId;
  final Value<String?> deviceName;
  final Value<String?> lastSeenLanIp;
  final Value<int?> lastSeenLanPort;
  final Value<Uint8List?> desktopPubkey;
  final Value<Uint8List?> relaySessionKey;
  final Value<String?> deviceToken;
  final Value<int> pairedAt;
  final Value<int?> lastConnectedAt;
  final Value<int?> lastAnnounceAt;
  const PairedDesktopsCompanion({
    this.id = const Value.absent(),
    this.deviceId = const Value.absent(),
    this.deviceName = const Value.absent(),
    this.lastSeenLanIp = const Value.absent(),
    this.lastSeenLanPort = const Value.absent(),
    this.desktopPubkey = const Value.absent(),
    this.relaySessionKey = const Value.absent(),
    this.deviceToken = const Value.absent(),
    this.pairedAt = const Value.absent(),
    this.lastConnectedAt = const Value.absent(),
    this.lastAnnounceAt = const Value.absent(),
  });
  PairedDesktopsCompanion.insert({
    this.id = const Value.absent(),
    required String deviceId,
    this.deviceName = const Value.absent(),
    this.lastSeenLanIp = const Value.absent(),
    this.lastSeenLanPort = const Value.absent(),
    this.desktopPubkey = const Value.absent(),
    this.relaySessionKey = const Value.absent(),
    this.deviceToken = const Value.absent(),
    required int pairedAt,
    this.lastConnectedAt = const Value.absent(),
    this.lastAnnounceAt = const Value.absent(),
  }) : deviceId = Value(deviceId),
       pairedAt = Value(pairedAt);
  static Insertable<PairedDesktop> custom({
    Expression<int>? id,
    Expression<String>? deviceId,
    Expression<String>? deviceName,
    Expression<String>? lastSeenLanIp,
    Expression<int>? lastSeenLanPort,
    Expression<Uint8List>? desktopPubkey,
    Expression<Uint8List>? relaySessionKey,
    Expression<String>? deviceToken,
    Expression<int>? pairedAt,
    Expression<int>? lastConnectedAt,
    Expression<int>? lastAnnounceAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (deviceId != null) 'device_id': deviceId,
      if (deviceName != null) 'device_name': deviceName,
      if (lastSeenLanIp != null) 'last_seen_lan_ip': lastSeenLanIp,
      if (lastSeenLanPort != null) 'last_seen_lan_port': lastSeenLanPort,
      if (desktopPubkey != null) 'desktop_pubkey': desktopPubkey,
      if (relaySessionKey != null) 'relay_session_key': relaySessionKey,
      if (deviceToken != null) 'device_token': deviceToken,
      if (pairedAt != null) 'paired_at': pairedAt,
      if (lastConnectedAt != null) 'last_connected_at': lastConnectedAt,
      if (lastAnnounceAt != null) 'last_announce_at': lastAnnounceAt,
    });
  }

  PairedDesktopsCompanion copyWith({
    Value<int>? id,
    Value<String>? deviceId,
    Value<String?>? deviceName,
    Value<String?>? lastSeenLanIp,
    Value<int?>? lastSeenLanPort,
    Value<Uint8List?>? desktopPubkey,
    Value<Uint8List?>? relaySessionKey,
    Value<String?>? deviceToken,
    Value<int>? pairedAt,
    Value<int?>? lastConnectedAt,
    Value<int?>? lastAnnounceAt,
  }) {
    return PairedDesktopsCompanion(
      id: id ?? this.id,
      deviceId: deviceId ?? this.deviceId,
      deviceName: deviceName ?? this.deviceName,
      lastSeenLanIp: lastSeenLanIp ?? this.lastSeenLanIp,
      lastSeenLanPort: lastSeenLanPort ?? this.lastSeenLanPort,
      desktopPubkey: desktopPubkey ?? this.desktopPubkey,
      relaySessionKey: relaySessionKey ?? this.relaySessionKey,
      deviceToken: deviceToken ?? this.deviceToken,
      pairedAt: pairedAt ?? this.pairedAt,
      lastConnectedAt: lastConnectedAt ?? this.lastConnectedAt,
      lastAnnounceAt: lastAnnounceAt ?? this.lastAnnounceAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (deviceId.present) {
      map['device_id'] = Variable<String>(deviceId.value);
    }
    if (deviceName.present) {
      map['device_name'] = Variable<String>(deviceName.value);
    }
    if (lastSeenLanIp.present) {
      map['last_seen_lan_ip'] = Variable<String>(lastSeenLanIp.value);
    }
    if (lastSeenLanPort.present) {
      map['last_seen_lan_port'] = Variable<int>(lastSeenLanPort.value);
    }
    if (desktopPubkey.present) {
      map['desktop_pubkey'] = Variable<Uint8List>(desktopPubkey.value);
    }
    if (relaySessionKey.present) {
      map['relay_session_key'] = Variable<Uint8List>(relaySessionKey.value);
    }
    if (deviceToken.present) {
      map['device_token'] = Variable<String>(deviceToken.value);
    }
    if (pairedAt.present) {
      map['paired_at'] = Variable<int>(pairedAt.value);
    }
    if (lastConnectedAt.present) {
      map['last_connected_at'] = Variable<int>(lastConnectedAt.value);
    }
    if (lastAnnounceAt.present) {
      map['last_announce_at'] = Variable<int>(lastAnnounceAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('PairedDesktopsCompanion(')
          ..write('id: $id, ')
          ..write('deviceId: $deviceId, ')
          ..write('deviceName: $deviceName, ')
          ..write('lastSeenLanIp: $lastSeenLanIp, ')
          ..write('lastSeenLanPort: $lastSeenLanPort, ')
          ..write('desktopPubkey: $desktopPubkey, ')
          ..write('relaySessionKey: $relaySessionKey, ')
          ..write('deviceToken: $deviceToken, ')
          ..write('pairedAt: $pairedAt, ')
          ..write('lastConnectedAt: $lastConnectedAt, ')
          ..write('lastAnnounceAt: $lastAnnounceAt')
          ..write(')'))
        .toString();
  }
}

class $SessionMirrorTable extends SessionMirror
    with TableInfo<$SessionMirrorTable, SessionMirrorData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionMirrorTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _desktopDeviceIdMeta = const VerificationMeta(
    'desktopDeviceId',
  );
  @override
  late final GeneratedColumn<String> desktopDeviceId = GeneratedColumn<String>(
    'desktop_device_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _workspaceNameMeta = const VerificationMeta(
    'workspaceName',
  );
  @override
  late final GeneratedColumn<String> workspaceName = GeneratedColumn<String>(
    'workspace_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastMessageAtMeta = const VerificationMeta(
    'lastMessageAt',
  );
  @override
  late final GeneratedColumn<int> lastMessageAt = GeneratedColumn<int>(
    'last_message_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastSeqMeta = const VerificationMeta(
    'lastSeq',
  );
  @override
  late final GeneratedColumn<int> lastSeq = GeneratedColumn<int>(
    'last_seq',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _isSensitiveMeta = const VerificationMeta(
    'isSensitive',
  );
  @override
  late final GeneratedColumn<bool> isSensitive = GeneratedColumn<bool>(
    'is_sensitive',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("is_sensitive" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('chat'),
  );
  static const VerificationMeta _agentModeMeta = const VerificationMeta(
    'agentMode',
  );
  @override
  late final GeneratedColumn<String> agentMode = GeneratedColumn<String>(
    'agent_mode',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _parentSessionIdMeta = const VerificationMeta(
    'parentSessionId',
  );
  @override
  late final GeneratedColumn<String> parentSessionId = GeneratedColumn<String>(
    'parent_session_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    desktopDeviceId,
    title,
    workspaceName,
    lastMessageAt,
    lastSeq,
    isSensitive,
    createdAt,
    kind,
    agentMode,
    parentSessionId,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_mirror';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionMirrorData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('desktop_device_id')) {
      context.handle(
        _desktopDeviceIdMeta,
        desktopDeviceId.isAcceptableOrUnknown(
          data['desktop_device_id']!,
          _desktopDeviceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_desktopDeviceIdMeta);
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    }
    if (data.containsKey('workspace_name')) {
      context.handle(
        _workspaceNameMeta,
        workspaceName.isAcceptableOrUnknown(
          data['workspace_name']!,
          _workspaceNameMeta,
        ),
      );
    }
    if (data.containsKey('last_message_at')) {
      context.handle(
        _lastMessageAtMeta,
        lastMessageAt.isAcceptableOrUnknown(
          data['last_message_at']!,
          _lastMessageAtMeta,
        ),
      );
    }
    if (data.containsKey('last_seq')) {
      context.handle(
        _lastSeqMeta,
        lastSeq.isAcceptableOrUnknown(data['last_seq']!, _lastSeqMeta),
      );
    }
    if (data.containsKey('is_sensitive')) {
      context.handle(
        _isSensitiveMeta,
        isSensitive.isAcceptableOrUnknown(
          data['is_sensitive']!,
          _isSensitiveMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    }
    if (data.containsKey('agent_mode')) {
      context.handle(
        _agentModeMeta,
        agentMode.isAcceptableOrUnknown(data['agent_mode']!, _agentModeMeta),
      );
    }
    if (data.containsKey('parent_session_id')) {
      context.handle(
        _parentSessionIdMeta,
        parentSessionId.isAcceptableOrUnknown(
          data['parent_session_id']!,
          _parentSessionIdMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  SessionMirrorData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionMirrorData(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      desktopDeviceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}desktop_device_id'],
      )!,
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      ),
      workspaceName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_name'],
      ),
      lastMessageAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_message_at'],
      ),
      lastSeq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_seq'],
      ),
      isSensitive: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}is_sensitive'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}created_at'],
      )!,
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      agentMode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}agent_mode'],
      ),
      parentSessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}parent_session_id'],
      ),
    );
  }

  @override
  $SessionMirrorTable createAlias(String alias) {
    return $SessionMirrorTable(attachedDatabase, alias);
  }
}

class SessionMirrorData extends DataClass
    implements Insertable<SessionMirrorData> {
  /// session uuid, 跟 Desktop 一致
  final String id;
  final String desktopDeviceId;
  final String? title;
  final String? workspaceName;
  final int? lastMessageAt;

  /// 已同步到的 seq 号, 用于增量补传 (协议 §3.5)
  final int? lastSeq;
  final bool isSensitive;
  final int createdAt;

  /// 会话种类 — 'chat' (默认) | 'image' (图片工作台 / 直连生图会话).
  /// 手机本机 image 会话走 ImageDirectService; 桌面同步来的 image 会话
  /// 在聊天页打开时仍提示「生图结果在电脑端查看」。
  final String kind;

  /// 这次会话跑在哪个模式下 — 'assistant' (对话) | 'work' | 'code'.
  ///
  /// 2026-09-04 补上。此前**模式从来没有被写进会话** —— 它只活在
  /// SharedPreferences 里的一个全局当前值。两个后果:
  ///   1. 已知 bug: 模式决定工作区, 但会话不记模式, 于是切回 code 时没人还原
  ///      项目, code 会话挂在「工作」目录下 (2026-08-31 记过);
  ///   2. 「工作」「编码」拿不出自己的历史 —— 所有会话在数据层是一个样子的。
  ///
  /// nullable: 存量行没有这个值, 不假装它们是 'assistant' —— 读的时候当"未知",
  /// 未知的会话在三个 home 里都显示。给个默认值反而会把一堆 code 会话说成对话。
  final String? agentMode;

  /// 非空 = 这是父会话派出的 sub-agent 子会话 (桌面 sessions.parent_session_id).
  /// 抽屉里嵌套在父会话下缩进显示, 不在顶层"最近"列表里单独占位。
  final String? parentSessionId;
  const SessionMirrorData({
    required this.id,
    required this.desktopDeviceId,
    this.title,
    this.workspaceName,
    this.lastMessageAt,
    this.lastSeq,
    required this.isSensitive,
    required this.createdAt,
    required this.kind,
    this.agentMode,
    this.parentSessionId,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['desktop_device_id'] = Variable<String>(desktopDeviceId);
    if (!nullToAbsent || title != null) {
      map['title'] = Variable<String>(title);
    }
    if (!nullToAbsent || workspaceName != null) {
      map['workspace_name'] = Variable<String>(workspaceName);
    }
    if (!nullToAbsent || lastMessageAt != null) {
      map['last_message_at'] = Variable<int>(lastMessageAt);
    }
    if (!nullToAbsent || lastSeq != null) {
      map['last_seq'] = Variable<int>(lastSeq);
    }
    map['is_sensitive'] = Variable<bool>(isSensitive);
    map['created_at'] = Variable<int>(createdAt);
    map['kind'] = Variable<String>(kind);
    if (!nullToAbsent || agentMode != null) {
      map['agent_mode'] = Variable<String>(agentMode);
    }
    if (!nullToAbsent || parentSessionId != null) {
      map['parent_session_id'] = Variable<String>(parentSessionId);
    }
    return map;
  }

  SessionMirrorCompanion toCompanion(bool nullToAbsent) {
    return SessionMirrorCompanion(
      id: Value(id),
      desktopDeviceId: Value(desktopDeviceId),
      title: title == null && nullToAbsent
          ? const Value.absent()
          : Value(title),
      workspaceName: workspaceName == null && nullToAbsent
          ? const Value.absent()
          : Value(workspaceName),
      lastMessageAt: lastMessageAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastMessageAt),
      lastSeq: lastSeq == null && nullToAbsent
          ? const Value.absent()
          : Value(lastSeq),
      isSensitive: Value(isSensitive),
      createdAt: Value(createdAt),
      kind: Value(kind),
      agentMode: agentMode == null && nullToAbsent
          ? const Value.absent()
          : Value(agentMode),
      parentSessionId: parentSessionId == null && nullToAbsent
          ? const Value.absent()
          : Value(parentSessionId),
    );
  }

  factory SessionMirrorData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionMirrorData(
      id: serializer.fromJson<String>(json['id']),
      desktopDeviceId: serializer.fromJson<String>(json['desktopDeviceId']),
      title: serializer.fromJson<String?>(json['title']),
      workspaceName: serializer.fromJson<String?>(json['workspaceName']),
      lastMessageAt: serializer.fromJson<int?>(json['lastMessageAt']),
      lastSeq: serializer.fromJson<int?>(json['lastSeq']),
      isSensitive: serializer.fromJson<bool>(json['isSensitive']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      kind: serializer.fromJson<String>(json['kind']),
      agentMode: serializer.fromJson<String?>(json['agentMode']),
      parentSessionId: serializer.fromJson<String?>(json['parentSessionId']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'desktopDeviceId': serializer.toJson<String>(desktopDeviceId),
      'title': serializer.toJson<String?>(title),
      'workspaceName': serializer.toJson<String?>(workspaceName),
      'lastMessageAt': serializer.toJson<int?>(lastMessageAt),
      'lastSeq': serializer.toJson<int?>(lastSeq),
      'isSensitive': serializer.toJson<bool>(isSensitive),
      'createdAt': serializer.toJson<int>(createdAt),
      'kind': serializer.toJson<String>(kind),
      'agentMode': serializer.toJson<String?>(agentMode),
      'parentSessionId': serializer.toJson<String?>(parentSessionId),
    };
  }

  SessionMirrorData copyWith({
    String? id,
    String? desktopDeviceId,
    Value<String?> title = const Value.absent(),
    Value<String?> workspaceName = const Value.absent(),
    Value<int?> lastMessageAt = const Value.absent(),
    Value<int?> lastSeq = const Value.absent(),
    bool? isSensitive,
    int? createdAt,
    String? kind,
    Value<String?> agentMode = const Value.absent(),
    Value<String?> parentSessionId = const Value.absent(),
  }) => SessionMirrorData(
    id: id ?? this.id,
    desktopDeviceId: desktopDeviceId ?? this.desktopDeviceId,
    title: title.present ? title.value : this.title,
    workspaceName: workspaceName.present
        ? workspaceName.value
        : this.workspaceName,
    lastMessageAt: lastMessageAt.present
        ? lastMessageAt.value
        : this.lastMessageAt,
    lastSeq: lastSeq.present ? lastSeq.value : this.lastSeq,
    isSensitive: isSensitive ?? this.isSensitive,
    createdAt: createdAt ?? this.createdAt,
    kind: kind ?? this.kind,
    agentMode: agentMode.present ? agentMode.value : this.agentMode,
    parentSessionId: parentSessionId.present
        ? parentSessionId.value
        : this.parentSessionId,
  );
  SessionMirrorData copyWithCompanion(SessionMirrorCompanion data) {
    return SessionMirrorData(
      id: data.id.present ? data.id.value : this.id,
      desktopDeviceId: data.desktopDeviceId.present
          ? data.desktopDeviceId.value
          : this.desktopDeviceId,
      title: data.title.present ? data.title.value : this.title,
      workspaceName: data.workspaceName.present
          ? data.workspaceName.value
          : this.workspaceName,
      lastMessageAt: data.lastMessageAt.present
          ? data.lastMessageAt.value
          : this.lastMessageAt,
      lastSeq: data.lastSeq.present ? data.lastSeq.value : this.lastSeq,
      isSensitive: data.isSensitive.present
          ? data.isSensitive.value
          : this.isSensitive,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      kind: data.kind.present ? data.kind.value : this.kind,
      agentMode: data.agentMode.present ? data.agentMode.value : this.agentMode,
      parentSessionId: data.parentSessionId.present
          ? data.parentSessionId.value
          : this.parentSessionId,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionMirrorData(')
          ..write('id: $id, ')
          ..write('desktopDeviceId: $desktopDeviceId, ')
          ..write('title: $title, ')
          ..write('workspaceName: $workspaceName, ')
          ..write('lastMessageAt: $lastMessageAt, ')
          ..write('lastSeq: $lastSeq, ')
          ..write('isSensitive: $isSensitive, ')
          ..write('createdAt: $createdAt, ')
          ..write('kind: $kind, ')
          ..write('agentMode: $agentMode, ')
          ..write('parentSessionId: $parentSessionId')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    desktopDeviceId,
    title,
    workspaceName,
    lastMessageAt,
    lastSeq,
    isSensitive,
    createdAt,
    kind,
    agentMode,
    parentSessionId,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionMirrorData &&
          other.id == this.id &&
          other.desktopDeviceId == this.desktopDeviceId &&
          other.title == this.title &&
          other.workspaceName == this.workspaceName &&
          other.lastMessageAt == this.lastMessageAt &&
          other.lastSeq == this.lastSeq &&
          other.isSensitive == this.isSensitive &&
          other.createdAt == this.createdAt &&
          other.kind == this.kind &&
          other.agentMode == this.agentMode &&
          other.parentSessionId == this.parentSessionId);
}

class SessionMirrorCompanion extends UpdateCompanion<SessionMirrorData> {
  final Value<String> id;
  final Value<String> desktopDeviceId;
  final Value<String?> title;
  final Value<String?> workspaceName;
  final Value<int?> lastMessageAt;
  final Value<int?> lastSeq;
  final Value<bool> isSensitive;
  final Value<int> createdAt;
  final Value<String> kind;
  final Value<String?> agentMode;
  final Value<String?> parentSessionId;
  final Value<int> rowid;
  const SessionMirrorCompanion({
    this.id = const Value.absent(),
    this.desktopDeviceId = const Value.absent(),
    this.title = const Value.absent(),
    this.workspaceName = const Value.absent(),
    this.lastMessageAt = const Value.absent(),
    this.lastSeq = const Value.absent(),
    this.isSensitive = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.kind = const Value.absent(),
    this.agentMode = const Value.absent(),
    this.parentSessionId = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionMirrorCompanion.insert({
    required String id,
    required String desktopDeviceId,
    this.title = const Value.absent(),
    this.workspaceName = const Value.absent(),
    this.lastMessageAt = const Value.absent(),
    this.lastSeq = const Value.absent(),
    this.isSensitive = const Value.absent(),
    required int createdAt,
    this.kind = const Value.absent(),
    this.agentMode = const Value.absent(),
    this.parentSessionId = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       desktopDeviceId = Value(desktopDeviceId),
       createdAt = Value(createdAt);
  static Insertable<SessionMirrorData> custom({
    Expression<String>? id,
    Expression<String>? desktopDeviceId,
    Expression<String>? title,
    Expression<String>? workspaceName,
    Expression<int>? lastMessageAt,
    Expression<int>? lastSeq,
    Expression<bool>? isSensitive,
    Expression<int>? createdAt,
    Expression<String>? kind,
    Expression<String>? agentMode,
    Expression<String>? parentSessionId,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (desktopDeviceId != null) 'desktop_device_id': desktopDeviceId,
      if (title != null) 'title': title,
      if (workspaceName != null) 'workspace_name': workspaceName,
      if (lastMessageAt != null) 'last_message_at': lastMessageAt,
      if (lastSeq != null) 'last_seq': lastSeq,
      if (isSensitive != null) 'is_sensitive': isSensitive,
      if (createdAt != null) 'created_at': createdAt,
      if (kind != null) 'kind': kind,
      if (agentMode != null) 'agent_mode': agentMode,
      if (parentSessionId != null) 'parent_session_id': parentSessionId,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionMirrorCompanion copyWith({
    Value<String>? id,
    Value<String>? desktopDeviceId,
    Value<String?>? title,
    Value<String?>? workspaceName,
    Value<int?>? lastMessageAt,
    Value<int?>? lastSeq,
    Value<bool>? isSensitive,
    Value<int>? createdAt,
    Value<String>? kind,
    Value<String?>? agentMode,
    Value<String?>? parentSessionId,
    Value<int>? rowid,
  }) {
    return SessionMirrorCompanion(
      id: id ?? this.id,
      desktopDeviceId: desktopDeviceId ?? this.desktopDeviceId,
      title: title ?? this.title,
      workspaceName: workspaceName ?? this.workspaceName,
      lastMessageAt: lastMessageAt ?? this.lastMessageAt,
      lastSeq: lastSeq ?? this.lastSeq,
      isSensitive: isSensitive ?? this.isSensitive,
      createdAt: createdAt ?? this.createdAt,
      kind: kind ?? this.kind,
      agentMode: agentMode ?? this.agentMode,
      parentSessionId: parentSessionId ?? this.parentSessionId,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (desktopDeviceId.present) {
      map['desktop_device_id'] = Variable<String>(desktopDeviceId.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (workspaceName.present) {
      map['workspace_name'] = Variable<String>(workspaceName.value);
    }
    if (lastMessageAt.present) {
      map['last_message_at'] = Variable<int>(lastMessageAt.value);
    }
    if (lastSeq.present) {
      map['last_seq'] = Variable<int>(lastSeq.value);
    }
    if (isSensitive.present) {
      map['is_sensitive'] = Variable<bool>(isSensitive.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (agentMode.present) {
      map['agent_mode'] = Variable<String>(agentMode.value);
    }
    if (parentSessionId.present) {
      map['parent_session_id'] = Variable<String>(parentSessionId.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionMirrorCompanion(')
          ..write('id: $id, ')
          ..write('desktopDeviceId: $desktopDeviceId, ')
          ..write('title: $title, ')
          ..write('workspaceName: $workspaceName, ')
          ..write('lastMessageAt: $lastMessageAt, ')
          ..write('lastSeq: $lastSeq, ')
          ..write('isSensitive: $isSensitive, ')
          ..write('createdAt: $createdAt, ')
          ..write('kind: $kind, ')
          ..write('agentMode: $agentMode, ')
          ..write('parentSessionId: $parentSessionId, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionEventsTable extends SessionEvents
    with TableInfo<$SessionEventsTable, SessionEvent> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionEventsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _seqMeta = const VerificationMeta('seq');
  @override
  late final GeneratedColumn<int> seq = GeneratedColumn<int>(
    'seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _tsMeta = const VerificationMeta('ts');
  @override
  late final GeneratedColumn<int> ts = GeneratedColumn<int>(
    'ts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadMeta = const VerificationMeta(
    'payload',
  );
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
    'payload',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [sessionId, seq, ts, kind, payload];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_events';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionEvent> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('seq')) {
      context.handle(
        _seqMeta,
        seq.isAcceptableOrUnknown(data['seq']!, _seqMeta),
      );
    } else if (isInserting) {
      context.missing(_seqMeta);
    }
    if (data.containsKey('ts')) {
      context.handle(_tsMeta, ts.isAcceptableOrUnknown(data['ts']!, _tsMeta));
    } else if (isInserting) {
      context.missing(_tsMeta);
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    } else if (isInserting) {
      context.missing(_kindMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(
        _payloadMeta,
        payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta),
      );
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sessionId, seq};
  @override
  SessionEvent map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionEvent(
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      seq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}seq'],
      )!,
      ts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}ts'],
      )!,
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      payload: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload'],
      )!,
    );
  }

  @override
  $SessionEventsTable createAlias(String alias) {
    return $SessionEventsTable(attachedDatabase, alias);
  }
}

class SessionEvent extends DataClass implements Insertable<SessionEvent> {
  final String sessionId;
  final int seq;
  final int ts;
  final String kind;

  /// JSON-encoded payload
  final String payload;
  const SessionEvent({
    required this.sessionId,
    required this.seq,
    required this.ts,
    required this.kind,
    required this.payload,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['session_id'] = Variable<String>(sessionId);
    map['seq'] = Variable<int>(seq);
    map['ts'] = Variable<int>(ts);
    map['kind'] = Variable<String>(kind);
    map['payload'] = Variable<String>(payload);
    return map;
  }

  SessionEventsCompanion toCompanion(bool nullToAbsent) {
    return SessionEventsCompanion(
      sessionId: Value(sessionId),
      seq: Value(seq),
      ts: Value(ts),
      kind: Value(kind),
      payload: Value(payload),
    );
  }

  factory SessionEvent.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionEvent(
      sessionId: serializer.fromJson<String>(json['sessionId']),
      seq: serializer.fromJson<int>(json['seq']),
      ts: serializer.fromJson<int>(json['ts']),
      kind: serializer.fromJson<String>(json['kind']),
      payload: serializer.fromJson<String>(json['payload']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sessionId': serializer.toJson<String>(sessionId),
      'seq': serializer.toJson<int>(seq),
      'ts': serializer.toJson<int>(ts),
      'kind': serializer.toJson<String>(kind),
      'payload': serializer.toJson<String>(payload),
    };
  }

  SessionEvent copyWith({
    String? sessionId,
    int? seq,
    int? ts,
    String? kind,
    String? payload,
  }) => SessionEvent(
    sessionId: sessionId ?? this.sessionId,
    seq: seq ?? this.seq,
    ts: ts ?? this.ts,
    kind: kind ?? this.kind,
    payload: payload ?? this.payload,
  );
  SessionEvent copyWithCompanion(SessionEventsCompanion data) {
    return SessionEvent(
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      seq: data.seq.present ? data.seq.value : this.seq,
      ts: data.ts.present ? data.ts.value : this.ts,
      kind: data.kind.present ? data.kind.value : this.kind,
      payload: data.payload.present ? data.payload.value : this.payload,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionEvent(')
          ..write('sessionId: $sessionId, ')
          ..write('seq: $seq, ')
          ..write('ts: $ts, ')
          ..write('kind: $kind, ')
          ..write('payload: $payload')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(sessionId, seq, ts, kind, payload);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionEvent &&
          other.sessionId == this.sessionId &&
          other.seq == this.seq &&
          other.ts == this.ts &&
          other.kind == this.kind &&
          other.payload == this.payload);
}

class SessionEventsCompanion extends UpdateCompanion<SessionEvent> {
  final Value<String> sessionId;
  final Value<int> seq;
  final Value<int> ts;
  final Value<String> kind;
  final Value<String> payload;
  final Value<int> rowid;
  const SessionEventsCompanion({
    this.sessionId = const Value.absent(),
    this.seq = const Value.absent(),
    this.ts = const Value.absent(),
    this.kind = const Value.absent(),
    this.payload = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionEventsCompanion.insert({
    required String sessionId,
    required int seq,
    required int ts,
    required String kind,
    required String payload,
    this.rowid = const Value.absent(),
  }) : sessionId = Value(sessionId),
       seq = Value(seq),
       ts = Value(ts),
       kind = Value(kind),
       payload = Value(payload);
  static Insertable<SessionEvent> custom({
    Expression<String>? sessionId,
    Expression<int>? seq,
    Expression<int>? ts,
    Expression<String>? kind,
    Expression<String>? payload,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sessionId != null) 'session_id': sessionId,
      if (seq != null) 'seq': seq,
      if (ts != null) 'ts': ts,
      if (kind != null) 'kind': kind,
      if (payload != null) 'payload': payload,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionEventsCompanion copyWith({
    Value<String>? sessionId,
    Value<int>? seq,
    Value<int>? ts,
    Value<String>? kind,
    Value<String>? payload,
    Value<int>? rowid,
  }) {
    return SessionEventsCompanion(
      sessionId: sessionId ?? this.sessionId,
      seq: seq ?? this.seq,
      ts: ts ?? this.ts,
      kind: kind ?? this.kind,
      payload: payload ?? this.payload,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (seq.present) {
      map['seq'] = Variable<int>(seq.value);
    }
    if (ts.present) {
      map['ts'] = Variable<int>(ts.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionEventsCompanion(')
          ..write('sessionId: $sessionId, ')
          ..write('seq: $seq, ')
          ..write('ts: $ts, ')
          ..write('kind: $kind, ')
          ..write('payload: $payload, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $InboxPendingTable extends InboxPending
    with TableInfo<$InboxPendingTable, InboxPendingData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $InboxPendingTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _desktopDeviceIdMeta = const VerificationMeta(
    'desktopDeviceId',
  );
  @override
  late final GeneratedColumn<String> desktopDeviceId = GeneratedColumn<String>(
    'desktop_device_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadMeta = const VerificationMeta(
    'payload',
  );
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
    'payload',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _deliveredAtMeta = const VerificationMeta(
    'deliveredAt',
  );
  @override
  late final GeneratedColumn<int> deliveredAt = GeneratedColumn<int>(
    'delivered_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    desktopDeviceId,
    payload,
    createdAt,
    deliveredAt,
    status,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'inbox_pending';
  @override
  VerificationContext validateIntegrity(
    Insertable<InboxPendingData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('desktop_device_id')) {
      context.handle(
        _desktopDeviceIdMeta,
        desktopDeviceId.isAcceptableOrUnknown(
          data['desktop_device_id']!,
          _desktopDeviceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_desktopDeviceIdMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(
        _payloadMeta,
        payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta),
      );
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('delivered_at')) {
      context.handle(
        _deliveredAtMeta,
        deliveredAt.isAcceptableOrUnknown(
          data['delivered_at']!,
          _deliveredAtMeta,
        ),
      );
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    } else if (isInserting) {
      context.missing(_statusMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  InboxPendingData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return InboxPendingData(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      desktopDeviceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}desktop_device_id'],
      )!,
      payload: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}created_at'],
      )!,
      deliveredAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}delivered_at'],
      ),
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
    );
  }

  @override
  $InboxPendingTable createAlias(String alias) {
    return $InboxPendingTable(attachedDatabase, alias);
  }
}

class InboxPendingData extends DataClass
    implements Insertable<InboxPendingData> {
  final String id;
  final String desktopDeviceId;

  /// JSON-encoded payload (E2E 加密前的明文 — Phone 自己留底备查)
  final String payload;
  final int createdAt;
  final int? deliveredAt;

  /// 'queued' | 'sent' | 'acked' | 'expired'
  final String status;
  const InboxPendingData({
    required this.id,
    required this.desktopDeviceId,
    required this.payload,
    required this.createdAt,
    this.deliveredAt,
    required this.status,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['desktop_device_id'] = Variable<String>(desktopDeviceId);
    map['payload'] = Variable<String>(payload);
    map['created_at'] = Variable<int>(createdAt);
    if (!nullToAbsent || deliveredAt != null) {
      map['delivered_at'] = Variable<int>(deliveredAt);
    }
    map['status'] = Variable<String>(status);
    return map;
  }

  InboxPendingCompanion toCompanion(bool nullToAbsent) {
    return InboxPendingCompanion(
      id: Value(id),
      desktopDeviceId: Value(desktopDeviceId),
      payload: Value(payload),
      createdAt: Value(createdAt),
      deliveredAt: deliveredAt == null && nullToAbsent
          ? const Value.absent()
          : Value(deliveredAt),
      status: Value(status),
    );
  }

  factory InboxPendingData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return InboxPendingData(
      id: serializer.fromJson<String>(json['id']),
      desktopDeviceId: serializer.fromJson<String>(json['desktopDeviceId']),
      payload: serializer.fromJson<String>(json['payload']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      deliveredAt: serializer.fromJson<int?>(json['deliveredAt']),
      status: serializer.fromJson<String>(json['status']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'desktopDeviceId': serializer.toJson<String>(desktopDeviceId),
      'payload': serializer.toJson<String>(payload),
      'createdAt': serializer.toJson<int>(createdAt),
      'deliveredAt': serializer.toJson<int?>(deliveredAt),
      'status': serializer.toJson<String>(status),
    };
  }

  InboxPendingData copyWith({
    String? id,
    String? desktopDeviceId,
    String? payload,
    int? createdAt,
    Value<int?> deliveredAt = const Value.absent(),
    String? status,
  }) => InboxPendingData(
    id: id ?? this.id,
    desktopDeviceId: desktopDeviceId ?? this.desktopDeviceId,
    payload: payload ?? this.payload,
    createdAt: createdAt ?? this.createdAt,
    deliveredAt: deliveredAt.present ? deliveredAt.value : this.deliveredAt,
    status: status ?? this.status,
  );
  InboxPendingData copyWithCompanion(InboxPendingCompanion data) {
    return InboxPendingData(
      id: data.id.present ? data.id.value : this.id,
      desktopDeviceId: data.desktopDeviceId.present
          ? data.desktopDeviceId.value
          : this.desktopDeviceId,
      payload: data.payload.present ? data.payload.value : this.payload,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      deliveredAt: data.deliveredAt.present
          ? data.deliveredAt.value
          : this.deliveredAt,
      status: data.status.present ? data.status.value : this.status,
    );
  }

  @override
  String toString() {
    return (StringBuffer('InboxPendingData(')
          ..write('id: $id, ')
          ..write('desktopDeviceId: $desktopDeviceId, ')
          ..write('payload: $payload, ')
          ..write('createdAt: $createdAt, ')
          ..write('deliveredAt: $deliveredAt, ')
          ..write('status: $status')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(id, desktopDeviceId, payload, createdAt, deliveredAt, status);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is InboxPendingData &&
          other.id == this.id &&
          other.desktopDeviceId == this.desktopDeviceId &&
          other.payload == this.payload &&
          other.createdAt == this.createdAt &&
          other.deliveredAt == this.deliveredAt &&
          other.status == this.status);
}

class InboxPendingCompanion extends UpdateCompanion<InboxPendingData> {
  final Value<String> id;
  final Value<String> desktopDeviceId;
  final Value<String> payload;
  final Value<int> createdAt;
  final Value<int?> deliveredAt;
  final Value<String> status;
  final Value<int> rowid;
  const InboxPendingCompanion({
    this.id = const Value.absent(),
    this.desktopDeviceId = const Value.absent(),
    this.payload = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.deliveredAt = const Value.absent(),
    this.status = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  InboxPendingCompanion.insert({
    required String id,
    required String desktopDeviceId,
    required String payload,
    required int createdAt,
    this.deliveredAt = const Value.absent(),
    required String status,
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       desktopDeviceId = Value(desktopDeviceId),
       payload = Value(payload),
       createdAt = Value(createdAt),
       status = Value(status);
  static Insertable<InboxPendingData> custom({
    Expression<String>? id,
    Expression<String>? desktopDeviceId,
    Expression<String>? payload,
    Expression<int>? createdAt,
    Expression<int>? deliveredAt,
    Expression<String>? status,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (desktopDeviceId != null) 'desktop_device_id': desktopDeviceId,
      if (payload != null) 'payload': payload,
      if (createdAt != null) 'created_at': createdAt,
      if (deliveredAt != null) 'delivered_at': deliveredAt,
      if (status != null) 'status': status,
      if (rowid != null) 'rowid': rowid,
    });
  }

  InboxPendingCompanion copyWith({
    Value<String>? id,
    Value<String>? desktopDeviceId,
    Value<String>? payload,
    Value<int>? createdAt,
    Value<int?>? deliveredAt,
    Value<String>? status,
    Value<int>? rowid,
  }) {
    return InboxPendingCompanion(
      id: id ?? this.id,
      desktopDeviceId: desktopDeviceId ?? this.desktopDeviceId,
      payload: payload ?? this.payload,
      createdAt: createdAt ?? this.createdAt,
      deliveredAt: deliveredAt ?? this.deliveredAt,
      status: status ?? this.status,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (desktopDeviceId.present) {
      map['desktop_device_id'] = Variable<String>(desktopDeviceId.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (deliveredAt.present) {
      map['delivered_at'] = Variable<int>(deliveredAt.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('InboxPendingCompanion(')
          ..write('id: $id, ')
          ..write('desktopDeviceId: $desktopDeviceId, ')
          ..write('payload: $payload, ')
          ..write('createdAt: $createdAt, ')
          ..write('deliveredAt: $deliveredAt, ')
          ..write('status: $status, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ChatTurnSamplesTable extends ChatTurnSamples
    with TableInfo<$ChatTurnSamplesTable, ChatTurnSample> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ChatTurnSamplesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _turnIndexMeta = const VerificationMeta(
    'turnIndex',
  );
  @override
  late final GeneratedColumn<int> turnIndex = GeneratedColumn<int>(
    'turn_index',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _modelIdMeta = const VerificationMeta(
    'modelId',
  );
  @override
  late final GeneratedColumn<String> modelId = GeneratedColumn<String>(
    'model_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _lightChatMeta = const VerificationMeta(
    'lightChat',
  );
  @override
  late final GeneratedColumn<bool> lightChat = GeneratedColumn<bool>(
    'light_chat',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("light_chat" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _sendToRequestMsMeta = const VerificationMeta(
    'sendToRequestMs',
  );
  @override
  late final GeneratedColumn<int> sendToRequestMs = GeneratedColumn<int>(
    'send_to_request_ms',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _requestToFirstMsMeta = const VerificationMeta(
    'requestToFirstMs',
  );
  @override
  late final GeneratedColumn<int> requestToFirstMs = GeneratedColumn<int>(
    'request_to_first_ms',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _firstTokenMsMeta = const VerificationMeta(
    'firstTokenMs',
  );
  @override
  late final GeneratedColumn<int> firstTokenMs = GeneratedColumn<int>(
    'first_token_ms',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _outcomeMeta = const VerificationMeta(
    'outcome',
  );
  @override
  late final GeneratedColumn<String> outcome = GeneratedColumn<String>(
    'outcome',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    sessionId,
    turnIndex,
    modelId,
    lightChat,
    sendToRequestMs,
    requestToFirstMs,
    firstTokenMs,
    outcome,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'chat_turn_samples';
  @override
  VerificationContext validateIntegrity(
    Insertable<ChatTurnSample> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('turn_index')) {
      context.handle(
        _turnIndexMeta,
        turnIndex.isAcceptableOrUnknown(data['turn_index']!, _turnIndexMeta),
      );
    } else if (isInserting) {
      context.missing(_turnIndexMeta);
    }
    if (data.containsKey('model_id')) {
      context.handle(
        _modelIdMeta,
        modelId.isAcceptableOrUnknown(data['model_id']!, _modelIdMeta),
      );
    } else if (isInserting) {
      context.missing(_modelIdMeta);
    }
    if (data.containsKey('light_chat')) {
      context.handle(
        _lightChatMeta,
        lightChat.isAcceptableOrUnknown(data['light_chat']!, _lightChatMeta),
      );
    }
    if (data.containsKey('send_to_request_ms')) {
      context.handle(
        _sendToRequestMsMeta,
        sendToRequestMs.isAcceptableOrUnknown(
          data['send_to_request_ms']!,
          _sendToRequestMsMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_sendToRequestMsMeta);
    }
    if (data.containsKey('request_to_first_ms')) {
      context.handle(
        _requestToFirstMsMeta,
        requestToFirstMs.isAcceptableOrUnknown(
          data['request_to_first_ms']!,
          _requestToFirstMsMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_requestToFirstMsMeta);
    }
    if (data.containsKey('first_token_ms')) {
      context.handle(
        _firstTokenMsMeta,
        firstTokenMs.isAcceptableOrUnknown(
          data['first_token_ms']!,
          _firstTokenMsMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_firstTokenMsMeta);
    }
    if (data.containsKey('outcome')) {
      context.handle(
        _outcomeMeta,
        outcome.isAcceptableOrUnknown(data['outcome']!, _outcomeMeta),
      );
    } else if (isInserting) {
      context.missing(_outcomeMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  ChatTurnSample map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ChatTurnSample(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      turnIndex: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}turn_index'],
      )!,
      modelId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}model_id'],
      )!,
      lightChat: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}light_chat'],
      )!,
      sendToRequestMs: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}send_to_request_ms'],
      )!,
      requestToFirstMs: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}request_to_first_ms'],
      )!,
      firstTokenMs: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}first_token_ms'],
      )!,
      outcome: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}outcome'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $ChatTurnSamplesTable createAlias(String alias) {
    return $ChatTurnSamplesTable(attachedDatabase, alias);
  }
}

class ChatTurnSample extends DataClass implements Insertable<ChatTurnSample> {
  final int id;
  final String sessionId;

  /// 会话内第几轮 (1 起, 写入时数已有行数推出)。
  final int turnIndex;
  final String modelId;

  /// 这一轮是不是轻聊天档 (只有搜索 + 画图)。
  final bool lightChat;

  /// 点发送 → 请求真正发出 (ms)。-1 = 没走到发请求。
  final int sendToRequestMs;

  /// 请求发出 → 首个可见正文 (ms)。-1 = 没等到字。
  final int requestToFirstMs;

  /// 点发送 → 首个可见正文 (ms)。-1 = 报错 / 空回复 / 被取消。
  final int firstTokenMs;

  /// 'ok' | 'no_first_token'。
  final String outcome;

  /// 用户点发送的时刻 (unix ms)。
  final int createdAt;
  const ChatTurnSample({
    required this.id,
    required this.sessionId,
    required this.turnIndex,
    required this.modelId,
    required this.lightChat,
    required this.sendToRequestMs,
    required this.requestToFirstMs,
    required this.firstTokenMs,
    required this.outcome,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['session_id'] = Variable<String>(sessionId);
    map['turn_index'] = Variable<int>(turnIndex);
    map['model_id'] = Variable<String>(modelId);
    map['light_chat'] = Variable<bool>(lightChat);
    map['send_to_request_ms'] = Variable<int>(sendToRequestMs);
    map['request_to_first_ms'] = Variable<int>(requestToFirstMs);
    map['first_token_ms'] = Variable<int>(firstTokenMs);
    map['outcome'] = Variable<String>(outcome);
    map['created_at'] = Variable<int>(createdAt);
    return map;
  }

  ChatTurnSamplesCompanion toCompanion(bool nullToAbsent) {
    return ChatTurnSamplesCompanion(
      id: Value(id),
      sessionId: Value(sessionId),
      turnIndex: Value(turnIndex),
      modelId: Value(modelId),
      lightChat: Value(lightChat),
      sendToRequestMs: Value(sendToRequestMs),
      requestToFirstMs: Value(requestToFirstMs),
      firstTokenMs: Value(firstTokenMs),
      outcome: Value(outcome),
      createdAt: Value(createdAt),
    );
  }

  factory ChatTurnSample.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ChatTurnSample(
      id: serializer.fromJson<int>(json['id']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      turnIndex: serializer.fromJson<int>(json['turnIndex']),
      modelId: serializer.fromJson<String>(json['modelId']),
      lightChat: serializer.fromJson<bool>(json['lightChat']),
      sendToRequestMs: serializer.fromJson<int>(json['sendToRequestMs']),
      requestToFirstMs: serializer.fromJson<int>(json['requestToFirstMs']),
      firstTokenMs: serializer.fromJson<int>(json['firstTokenMs']),
      outcome: serializer.fromJson<String>(json['outcome']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'sessionId': serializer.toJson<String>(sessionId),
      'turnIndex': serializer.toJson<int>(turnIndex),
      'modelId': serializer.toJson<String>(modelId),
      'lightChat': serializer.toJson<bool>(lightChat),
      'sendToRequestMs': serializer.toJson<int>(sendToRequestMs),
      'requestToFirstMs': serializer.toJson<int>(requestToFirstMs),
      'firstTokenMs': serializer.toJson<int>(firstTokenMs),
      'outcome': serializer.toJson<String>(outcome),
      'createdAt': serializer.toJson<int>(createdAt),
    };
  }

  ChatTurnSample copyWith({
    int? id,
    String? sessionId,
    int? turnIndex,
    String? modelId,
    bool? lightChat,
    int? sendToRequestMs,
    int? requestToFirstMs,
    int? firstTokenMs,
    String? outcome,
    int? createdAt,
  }) => ChatTurnSample(
    id: id ?? this.id,
    sessionId: sessionId ?? this.sessionId,
    turnIndex: turnIndex ?? this.turnIndex,
    modelId: modelId ?? this.modelId,
    lightChat: lightChat ?? this.lightChat,
    sendToRequestMs: sendToRequestMs ?? this.sendToRequestMs,
    requestToFirstMs: requestToFirstMs ?? this.requestToFirstMs,
    firstTokenMs: firstTokenMs ?? this.firstTokenMs,
    outcome: outcome ?? this.outcome,
    createdAt: createdAt ?? this.createdAt,
  );
  ChatTurnSample copyWithCompanion(ChatTurnSamplesCompanion data) {
    return ChatTurnSample(
      id: data.id.present ? data.id.value : this.id,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      turnIndex: data.turnIndex.present ? data.turnIndex.value : this.turnIndex,
      modelId: data.modelId.present ? data.modelId.value : this.modelId,
      lightChat: data.lightChat.present ? data.lightChat.value : this.lightChat,
      sendToRequestMs: data.sendToRequestMs.present
          ? data.sendToRequestMs.value
          : this.sendToRequestMs,
      requestToFirstMs: data.requestToFirstMs.present
          ? data.requestToFirstMs.value
          : this.requestToFirstMs,
      firstTokenMs: data.firstTokenMs.present
          ? data.firstTokenMs.value
          : this.firstTokenMs,
      outcome: data.outcome.present ? data.outcome.value : this.outcome,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ChatTurnSample(')
          ..write('id: $id, ')
          ..write('sessionId: $sessionId, ')
          ..write('turnIndex: $turnIndex, ')
          ..write('modelId: $modelId, ')
          ..write('lightChat: $lightChat, ')
          ..write('sendToRequestMs: $sendToRequestMs, ')
          ..write('requestToFirstMs: $requestToFirstMs, ')
          ..write('firstTokenMs: $firstTokenMs, ')
          ..write('outcome: $outcome, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    sessionId,
    turnIndex,
    modelId,
    lightChat,
    sendToRequestMs,
    requestToFirstMs,
    firstTokenMs,
    outcome,
    createdAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ChatTurnSample &&
          other.id == this.id &&
          other.sessionId == this.sessionId &&
          other.turnIndex == this.turnIndex &&
          other.modelId == this.modelId &&
          other.lightChat == this.lightChat &&
          other.sendToRequestMs == this.sendToRequestMs &&
          other.requestToFirstMs == this.requestToFirstMs &&
          other.firstTokenMs == this.firstTokenMs &&
          other.outcome == this.outcome &&
          other.createdAt == this.createdAt);
}

class ChatTurnSamplesCompanion extends UpdateCompanion<ChatTurnSample> {
  final Value<int> id;
  final Value<String> sessionId;
  final Value<int> turnIndex;
  final Value<String> modelId;
  final Value<bool> lightChat;
  final Value<int> sendToRequestMs;
  final Value<int> requestToFirstMs;
  final Value<int> firstTokenMs;
  final Value<String> outcome;
  final Value<int> createdAt;
  const ChatTurnSamplesCompanion({
    this.id = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.turnIndex = const Value.absent(),
    this.modelId = const Value.absent(),
    this.lightChat = const Value.absent(),
    this.sendToRequestMs = const Value.absent(),
    this.requestToFirstMs = const Value.absent(),
    this.firstTokenMs = const Value.absent(),
    this.outcome = const Value.absent(),
    this.createdAt = const Value.absent(),
  });
  ChatTurnSamplesCompanion.insert({
    this.id = const Value.absent(),
    required String sessionId,
    required int turnIndex,
    required String modelId,
    this.lightChat = const Value.absent(),
    required int sendToRequestMs,
    required int requestToFirstMs,
    required int firstTokenMs,
    required String outcome,
    required int createdAt,
  }) : sessionId = Value(sessionId),
       turnIndex = Value(turnIndex),
       modelId = Value(modelId),
       sendToRequestMs = Value(sendToRequestMs),
       requestToFirstMs = Value(requestToFirstMs),
       firstTokenMs = Value(firstTokenMs),
       outcome = Value(outcome),
       createdAt = Value(createdAt);
  static Insertable<ChatTurnSample> custom({
    Expression<int>? id,
    Expression<String>? sessionId,
    Expression<int>? turnIndex,
    Expression<String>? modelId,
    Expression<bool>? lightChat,
    Expression<int>? sendToRequestMs,
    Expression<int>? requestToFirstMs,
    Expression<int>? firstTokenMs,
    Expression<String>? outcome,
    Expression<int>? createdAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (sessionId != null) 'session_id': sessionId,
      if (turnIndex != null) 'turn_index': turnIndex,
      if (modelId != null) 'model_id': modelId,
      if (lightChat != null) 'light_chat': lightChat,
      if (sendToRequestMs != null) 'send_to_request_ms': sendToRequestMs,
      if (requestToFirstMs != null) 'request_to_first_ms': requestToFirstMs,
      if (firstTokenMs != null) 'first_token_ms': firstTokenMs,
      if (outcome != null) 'outcome': outcome,
      if (createdAt != null) 'created_at': createdAt,
    });
  }

  ChatTurnSamplesCompanion copyWith({
    Value<int>? id,
    Value<String>? sessionId,
    Value<int>? turnIndex,
    Value<String>? modelId,
    Value<bool>? lightChat,
    Value<int>? sendToRequestMs,
    Value<int>? requestToFirstMs,
    Value<int>? firstTokenMs,
    Value<String>? outcome,
    Value<int>? createdAt,
  }) {
    return ChatTurnSamplesCompanion(
      id: id ?? this.id,
      sessionId: sessionId ?? this.sessionId,
      turnIndex: turnIndex ?? this.turnIndex,
      modelId: modelId ?? this.modelId,
      lightChat: lightChat ?? this.lightChat,
      sendToRequestMs: sendToRequestMs ?? this.sendToRequestMs,
      requestToFirstMs: requestToFirstMs ?? this.requestToFirstMs,
      firstTokenMs: firstTokenMs ?? this.firstTokenMs,
      outcome: outcome ?? this.outcome,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (turnIndex.present) {
      map['turn_index'] = Variable<int>(turnIndex.value);
    }
    if (modelId.present) {
      map['model_id'] = Variable<String>(modelId.value);
    }
    if (lightChat.present) {
      map['light_chat'] = Variable<bool>(lightChat.value);
    }
    if (sendToRequestMs.present) {
      map['send_to_request_ms'] = Variable<int>(sendToRequestMs.value);
    }
    if (requestToFirstMs.present) {
      map['request_to_first_ms'] = Variable<int>(requestToFirstMs.value);
    }
    if (firstTokenMs.present) {
      map['first_token_ms'] = Variable<int>(firstTokenMs.value);
    }
    if (outcome.present) {
      map['outcome'] = Variable<String>(outcome.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ChatTurnSamplesCompanion(')
          ..write('id: $id, ')
          ..write('sessionId: $sessionId, ')
          ..write('turnIndex: $turnIndex, ')
          ..write('modelId: $modelId, ')
          ..write('lightChat: $lightChat, ')
          ..write('sendToRequestMs: $sendToRequestMs, ')
          ..write('requestToFirstMs: $requestToFirstMs, ')
          ..write('firstTokenMs: $firstTokenMs, ')
          ..write('outcome: $outcome, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $PairedDesktopsTable pairedDesktops = $PairedDesktopsTable(this);
  late final $SessionMirrorTable sessionMirror = $SessionMirrorTable(this);
  late final $SessionEventsTable sessionEvents = $SessionEventsTable(this);
  late final $InboxPendingTable inboxPending = $InboxPendingTable(this);
  late final $ChatTurnSamplesTable chatTurnSamples = $ChatTurnSamplesTable(
    this,
  );
  late final PairedDesktopsDao pairedDesktopsDao = PairedDesktopsDao(
    this as AppDatabase,
  );
  late final SessionMirrorDao sessionMirrorDao = SessionMirrorDao(
    this as AppDatabase,
  );
  late final SessionEventsDao sessionEventsDao = SessionEventsDao(
    this as AppDatabase,
  );
  late final InboxPendingDao inboxPendingDao = InboxPendingDao(
    this as AppDatabase,
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    pairedDesktops,
    sessionMirror,
    sessionEvents,
    inboxPending,
    chatTurnSamples,
  ];
}

typedef $$PairedDesktopsTableCreateCompanionBuilder =
    PairedDesktopsCompanion Function({
      Value<int> id,
      required String deviceId,
      Value<String?> deviceName,
      Value<String?> lastSeenLanIp,
      Value<int?> lastSeenLanPort,
      Value<Uint8List?> desktopPubkey,
      Value<Uint8List?> relaySessionKey,
      Value<String?> deviceToken,
      required int pairedAt,
      Value<int?> lastConnectedAt,
      Value<int?> lastAnnounceAt,
    });
typedef $$PairedDesktopsTableUpdateCompanionBuilder =
    PairedDesktopsCompanion Function({
      Value<int> id,
      Value<String> deviceId,
      Value<String?> deviceName,
      Value<String?> lastSeenLanIp,
      Value<int?> lastSeenLanPort,
      Value<Uint8List?> desktopPubkey,
      Value<Uint8List?> relaySessionKey,
      Value<String?> deviceToken,
      Value<int> pairedAt,
      Value<int?> lastConnectedAt,
      Value<int?> lastAnnounceAt,
    });

class $$PairedDesktopsTableFilterComposer
    extends Composer<_$AppDatabase, $PairedDesktopsTable> {
  $$PairedDesktopsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get deviceId => $composableBuilder(
    column: $table.deviceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get deviceName => $composableBuilder(
    column: $table.deviceName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastSeenLanIp => $composableBuilder(
    column: $table.lastSeenLanIp,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastSeenLanPort => $composableBuilder(
    column: $table.lastSeenLanPort,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<Uint8List> get desktopPubkey => $composableBuilder(
    column: $table.desktopPubkey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<Uint8List> get relaySessionKey => $composableBuilder(
    column: $table.relaySessionKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get deviceToken => $composableBuilder(
    column: $table.deviceToken,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pairedAt => $composableBuilder(
    column: $table.pairedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastConnectedAt => $composableBuilder(
    column: $table.lastConnectedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastAnnounceAt => $composableBuilder(
    column: $table.lastAnnounceAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$PairedDesktopsTableOrderingComposer
    extends Composer<_$AppDatabase, $PairedDesktopsTable> {
  $$PairedDesktopsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get deviceId => $composableBuilder(
    column: $table.deviceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get deviceName => $composableBuilder(
    column: $table.deviceName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastSeenLanIp => $composableBuilder(
    column: $table.lastSeenLanIp,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastSeenLanPort => $composableBuilder(
    column: $table.lastSeenLanPort,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<Uint8List> get desktopPubkey => $composableBuilder(
    column: $table.desktopPubkey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<Uint8List> get relaySessionKey => $composableBuilder(
    column: $table.relaySessionKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get deviceToken => $composableBuilder(
    column: $table.deviceToken,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pairedAt => $composableBuilder(
    column: $table.pairedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastConnectedAt => $composableBuilder(
    column: $table.lastConnectedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastAnnounceAt => $composableBuilder(
    column: $table.lastAnnounceAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$PairedDesktopsTableAnnotationComposer
    extends Composer<_$AppDatabase, $PairedDesktopsTable> {
  $$PairedDesktopsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get deviceId =>
      $composableBuilder(column: $table.deviceId, builder: (column) => column);

  GeneratedColumn<String> get deviceName => $composableBuilder(
    column: $table.deviceName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get lastSeenLanIp => $composableBuilder(
    column: $table.lastSeenLanIp,
    builder: (column) => column,
  );

  GeneratedColumn<int> get lastSeenLanPort => $composableBuilder(
    column: $table.lastSeenLanPort,
    builder: (column) => column,
  );

  GeneratedColumn<Uint8List> get desktopPubkey => $composableBuilder(
    column: $table.desktopPubkey,
    builder: (column) => column,
  );

  GeneratedColumn<Uint8List> get relaySessionKey => $composableBuilder(
    column: $table.relaySessionKey,
    builder: (column) => column,
  );

  GeneratedColumn<String> get deviceToken => $composableBuilder(
    column: $table.deviceToken,
    builder: (column) => column,
  );

  GeneratedColumn<int> get pairedAt =>
      $composableBuilder(column: $table.pairedAt, builder: (column) => column);

  GeneratedColumn<int> get lastConnectedAt => $composableBuilder(
    column: $table.lastConnectedAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get lastAnnounceAt => $composableBuilder(
    column: $table.lastAnnounceAt,
    builder: (column) => column,
  );
}

class $$PairedDesktopsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $PairedDesktopsTable,
          PairedDesktop,
          $$PairedDesktopsTableFilterComposer,
          $$PairedDesktopsTableOrderingComposer,
          $$PairedDesktopsTableAnnotationComposer,
          $$PairedDesktopsTableCreateCompanionBuilder,
          $$PairedDesktopsTableUpdateCompanionBuilder,
          (
            PairedDesktop,
            BaseReferences<_$AppDatabase, $PairedDesktopsTable, PairedDesktop>,
          ),
          PairedDesktop,
          PrefetchHooks Function()
        > {
  $$PairedDesktopsTableTableManager(
    _$AppDatabase db,
    $PairedDesktopsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$PairedDesktopsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$PairedDesktopsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$PairedDesktopsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> deviceId = const Value.absent(),
                Value<String?> deviceName = const Value.absent(),
                Value<String?> lastSeenLanIp = const Value.absent(),
                Value<int?> lastSeenLanPort = const Value.absent(),
                Value<Uint8List?> desktopPubkey = const Value.absent(),
                Value<Uint8List?> relaySessionKey = const Value.absent(),
                Value<String?> deviceToken = const Value.absent(),
                Value<int> pairedAt = const Value.absent(),
                Value<int?> lastConnectedAt = const Value.absent(),
                Value<int?> lastAnnounceAt = const Value.absent(),
              }) => PairedDesktopsCompanion(
                id: id,
                deviceId: deviceId,
                deviceName: deviceName,
                lastSeenLanIp: lastSeenLanIp,
                lastSeenLanPort: lastSeenLanPort,
                desktopPubkey: desktopPubkey,
                relaySessionKey: relaySessionKey,
                deviceToken: deviceToken,
                pairedAt: pairedAt,
                lastConnectedAt: lastConnectedAt,
                lastAnnounceAt: lastAnnounceAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String deviceId,
                Value<String?> deviceName = const Value.absent(),
                Value<String?> lastSeenLanIp = const Value.absent(),
                Value<int?> lastSeenLanPort = const Value.absent(),
                Value<Uint8List?> desktopPubkey = const Value.absent(),
                Value<Uint8List?> relaySessionKey = const Value.absent(),
                Value<String?> deviceToken = const Value.absent(),
                required int pairedAt,
                Value<int?> lastConnectedAt = const Value.absent(),
                Value<int?> lastAnnounceAt = const Value.absent(),
              }) => PairedDesktopsCompanion.insert(
                id: id,
                deviceId: deviceId,
                deviceName: deviceName,
                lastSeenLanIp: lastSeenLanIp,
                lastSeenLanPort: lastSeenLanPort,
                desktopPubkey: desktopPubkey,
                relaySessionKey: relaySessionKey,
                deviceToken: deviceToken,
                pairedAt: pairedAt,
                lastConnectedAt: lastConnectedAt,
                lastAnnounceAt: lastAnnounceAt,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$PairedDesktopsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $PairedDesktopsTable,
      PairedDesktop,
      $$PairedDesktopsTableFilterComposer,
      $$PairedDesktopsTableOrderingComposer,
      $$PairedDesktopsTableAnnotationComposer,
      $$PairedDesktopsTableCreateCompanionBuilder,
      $$PairedDesktopsTableUpdateCompanionBuilder,
      (
        PairedDesktop,
        BaseReferences<_$AppDatabase, $PairedDesktopsTable, PairedDesktop>,
      ),
      PairedDesktop,
      PrefetchHooks Function()
    >;
typedef $$SessionMirrorTableCreateCompanionBuilder =
    SessionMirrorCompanion Function({
      required String id,
      required String desktopDeviceId,
      Value<String?> title,
      Value<String?> workspaceName,
      Value<int?> lastMessageAt,
      Value<int?> lastSeq,
      Value<bool> isSensitive,
      required int createdAt,
      Value<String> kind,
      Value<String?> agentMode,
      Value<String?> parentSessionId,
      Value<int> rowid,
    });
typedef $$SessionMirrorTableUpdateCompanionBuilder =
    SessionMirrorCompanion Function({
      Value<String> id,
      Value<String> desktopDeviceId,
      Value<String?> title,
      Value<String?> workspaceName,
      Value<int?> lastMessageAt,
      Value<int?> lastSeq,
      Value<bool> isSensitive,
      Value<int> createdAt,
      Value<String> kind,
      Value<String?> agentMode,
      Value<String?> parentSessionId,
      Value<int> rowid,
    });

class $$SessionMirrorTableFilterComposer
    extends Composer<_$AppDatabase, $SessionMirrorTable> {
  $$SessionMirrorTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get workspaceName => $composableBuilder(
    column: $table.workspaceName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastMessageAt => $composableBuilder(
    column: $table.lastMessageAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastSeq => $composableBuilder(
    column: $table.lastSeq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get isSensitive => $composableBuilder(
    column: $table.isSensitive,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get agentMode => $composableBuilder(
    column: $table.agentMode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get parentSessionId => $composableBuilder(
    column: $table.parentSessionId,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionMirrorTableOrderingComposer
    extends Composer<_$AppDatabase, $SessionMirrorTable> {
  $$SessionMirrorTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get workspaceName => $composableBuilder(
    column: $table.workspaceName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastMessageAt => $composableBuilder(
    column: $table.lastMessageAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastSeq => $composableBuilder(
    column: $table.lastSeq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get isSensitive => $composableBuilder(
    column: $table.isSensitive,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get agentMode => $composableBuilder(
    column: $table.agentMode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get parentSessionId => $composableBuilder(
    column: $table.parentSessionId,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionMirrorTableAnnotationComposer
    extends Composer<_$AppDatabase, $SessionMirrorTable> {
  $$SessionMirrorTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<String> get workspaceName => $composableBuilder(
    column: $table.workspaceName,
    builder: (column) => column,
  );

  GeneratedColumn<int> get lastMessageAt => $composableBuilder(
    column: $table.lastMessageAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get lastSeq =>
      $composableBuilder(column: $table.lastSeq, builder: (column) => column);

  GeneratedColumn<bool> get isSensitive => $composableBuilder(
    column: $table.isSensitive,
    builder: (column) => column,
  );

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get agentMode =>
      $composableBuilder(column: $table.agentMode, builder: (column) => column);

  GeneratedColumn<String> get parentSessionId => $composableBuilder(
    column: $table.parentSessionId,
    builder: (column) => column,
  );
}

class $$SessionMirrorTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SessionMirrorTable,
          SessionMirrorData,
          $$SessionMirrorTableFilterComposer,
          $$SessionMirrorTableOrderingComposer,
          $$SessionMirrorTableAnnotationComposer,
          $$SessionMirrorTableCreateCompanionBuilder,
          $$SessionMirrorTableUpdateCompanionBuilder,
          (
            SessionMirrorData,
            BaseReferences<
              _$AppDatabase,
              $SessionMirrorTable,
              SessionMirrorData
            >,
          ),
          SessionMirrorData,
          PrefetchHooks Function()
        > {
  $$SessionMirrorTableTableManager(_$AppDatabase db, $SessionMirrorTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionMirrorTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionMirrorTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionMirrorTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> desktopDeviceId = const Value.absent(),
                Value<String?> title = const Value.absent(),
                Value<String?> workspaceName = const Value.absent(),
                Value<int?> lastMessageAt = const Value.absent(),
                Value<int?> lastSeq = const Value.absent(),
                Value<bool> isSensitive = const Value.absent(),
                Value<int> createdAt = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String?> agentMode = const Value.absent(),
                Value<String?> parentSessionId = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionMirrorCompanion(
                id: id,
                desktopDeviceId: desktopDeviceId,
                title: title,
                workspaceName: workspaceName,
                lastMessageAt: lastMessageAt,
                lastSeq: lastSeq,
                isSensitive: isSensitive,
                createdAt: createdAt,
                kind: kind,
                agentMode: agentMode,
                parentSessionId: parentSessionId,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String desktopDeviceId,
                Value<String?> title = const Value.absent(),
                Value<String?> workspaceName = const Value.absent(),
                Value<int?> lastMessageAt = const Value.absent(),
                Value<int?> lastSeq = const Value.absent(),
                Value<bool> isSensitive = const Value.absent(),
                required int createdAt,
                Value<String> kind = const Value.absent(),
                Value<String?> agentMode = const Value.absent(),
                Value<String?> parentSessionId = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionMirrorCompanion.insert(
                id: id,
                desktopDeviceId: desktopDeviceId,
                title: title,
                workspaceName: workspaceName,
                lastMessageAt: lastMessageAt,
                lastSeq: lastSeq,
                isSensitive: isSensitive,
                createdAt: createdAt,
                kind: kind,
                agentMode: agentMode,
                parentSessionId: parentSessionId,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionMirrorTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SessionMirrorTable,
      SessionMirrorData,
      $$SessionMirrorTableFilterComposer,
      $$SessionMirrorTableOrderingComposer,
      $$SessionMirrorTableAnnotationComposer,
      $$SessionMirrorTableCreateCompanionBuilder,
      $$SessionMirrorTableUpdateCompanionBuilder,
      (
        SessionMirrorData,
        BaseReferences<_$AppDatabase, $SessionMirrorTable, SessionMirrorData>,
      ),
      SessionMirrorData,
      PrefetchHooks Function()
    >;
typedef $$SessionEventsTableCreateCompanionBuilder =
    SessionEventsCompanion Function({
      required String sessionId,
      required int seq,
      required int ts,
      required String kind,
      required String payload,
      Value<int> rowid,
    });
typedef $$SessionEventsTableUpdateCompanionBuilder =
    SessionEventsCompanion Function({
      Value<String> sessionId,
      Value<int> seq,
      Value<int> ts,
      Value<String> kind,
      Value<String> payload,
      Value<int> rowid,
    });

class $$SessionEventsTableFilterComposer
    extends Composer<_$AppDatabase, $SessionEventsTable> {
  $$SessionEventsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionEventsTableOrderingComposer
    extends Composer<_$AppDatabase, $SessionEventsTable> {
  $$SessionEventsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionEventsTableAnnotationComposer
    extends Composer<_$AppDatabase, $SessionEventsTable> {
  $$SessionEventsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<int> get seq =>
      $composableBuilder(column: $table.seq, builder: (column) => column);

  GeneratedColumn<int> get ts =>
      $composableBuilder(column: $table.ts, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);
}

class $$SessionEventsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SessionEventsTable,
          SessionEvent,
          $$SessionEventsTableFilterComposer,
          $$SessionEventsTableOrderingComposer,
          $$SessionEventsTableAnnotationComposer,
          $$SessionEventsTableCreateCompanionBuilder,
          $$SessionEventsTableUpdateCompanionBuilder,
          (
            SessionEvent,
            BaseReferences<_$AppDatabase, $SessionEventsTable, SessionEvent>,
          ),
          SessionEvent,
          PrefetchHooks Function()
        > {
  $$SessionEventsTableTableManager(_$AppDatabase db, $SessionEventsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionEventsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionEventsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionEventsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> sessionId = const Value.absent(),
                Value<int> seq = const Value.absent(),
                Value<int> ts = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String> payload = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionEventsCompanion(
                sessionId: sessionId,
                seq: seq,
                ts: ts,
                kind: kind,
                payload: payload,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sessionId,
                required int seq,
                required int ts,
                required String kind,
                required String payload,
                Value<int> rowid = const Value.absent(),
              }) => SessionEventsCompanion.insert(
                sessionId: sessionId,
                seq: seq,
                ts: ts,
                kind: kind,
                payload: payload,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionEventsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SessionEventsTable,
      SessionEvent,
      $$SessionEventsTableFilterComposer,
      $$SessionEventsTableOrderingComposer,
      $$SessionEventsTableAnnotationComposer,
      $$SessionEventsTableCreateCompanionBuilder,
      $$SessionEventsTableUpdateCompanionBuilder,
      (
        SessionEvent,
        BaseReferences<_$AppDatabase, $SessionEventsTable, SessionEvent>,
      ),
      SessionEvent,
      PrefetchHooks Function()
    >;
typedef $$InboxPendingTableCreateCompanionBuilder =
    InboxPendingCompanion Function({
      required String id,
      required String desktopDeviceId,
      required String payload,
      required int createdAt,
      Value<int?> deliveredAt,
      required String status,
      Value<int> rowid,
    });
typedef $$InboxPendingTableUpdateCompanionBuilder =
    InboxPendingCompanion Function({
      Value<String> id,
      Value<String> desktopDeviceId,
      Value<String> payload,
      Value<int> createdAt,
      Value<int?> deliveredAt,
      Value<String> status,
      Value<int> rowid,
    });

class $$InboxPendingTableFilterComposer
    extends Composer<_$AppDatabase, $InboxPendingTable> {
  $$InboxPendingTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get deliveredAt => $composableBuilder(
    column: $table.deliveredAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );
}

class $$InboxPendingTableOrderingComposer
    extends Composer<_$AppDatabase, $InboxPendingTable> {
  $$InboxPendingTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get deliveredAt => $composableBuilder(
    column: $table.deliveredAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$InboxPendingTableAnnotationComposer
    extends Composer<_$AppDatabase, $InboxPendingTable> {
  $$InboxPendingTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get desktopDeviceId => $composableBuilder(
    column: $table.desktopDeviceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<int> get deliveredAt => $composableBuilder(
    column: $table.deliveredAt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);
}

class $$InboxPendingTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $InboxPendingTable,
          InboxPendingData,
          $$InboxPendingTableFilterComposer,
          $$InboxPendingTableOrderingComposer,
          $$InboxPendingTableAnnotationComposer,
          $$InboxPendingTableCreateCompanionBuilder,
          $$InboxPendingTableUpdateCompanionBuilder,
          (
            InboxPendingData,
            BaseReferences<_$AppDatabase, $InboxPendingTable, InboxPendingData>,
          ),
          InboxPendingData,
          PrefetchHooks Function()
        > {
  $$InboxPendingTableTableManager(_$AppDatabase db, $InboxPendingTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$InboxPendingTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$InboxPendingTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$InboxPendingTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> desktopDeviceId = const Value.absent(),
                Value<String> payload = const Value.absent(),
                Value<int> createdAt = const Value.absent(),
                Value<int?> deliveredAt = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => InboxPendingCompanion(
                id: id,
                desktopDeviceId: desktopDeviceId,
                payload: payload,
                createdAt: createdAt,
                deliveredAt: deliveredAt,
                status: status,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String desktopDeviceId,
                required String payload,
                required int createdAt,
                Value<int?> deliveredAt = const Value.absent(),
                required String status,
                Value<int> rowid = const Value.absent(),
              }) => InboxPendingCompanion.insert(
                id: id,
                desktopDeviceId: desktopDeviceId,
                payload: payload,
                createdAt: createdAt,
                deliveredAt: deliveredAt,
                status: status,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$InboxPendingTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $InboxPendingTable,
      InboxPendingData,
      $$InboxPendingTableFilterComposer,
      $$InboxPendingTableOrderingComposer,
      $$InboxPendingTableAnnotationComposer,
      $$InboxPendingTableCreateCompanionBuilder,
      $$InboxPendingTableUpdateCompanionBuilder,
      (
        InboxPendingData,
        BaseReferences<_$AppDatabase, $InboxPendingTable, InboxPendingData>,
      ),
      InboxPendingData,
      PrefetchHooks Function()
    >;
typedef $$ChatTurnSamplesTableCreateCompanionBuilder =
    ChatTurnSamplesCompanion Function({
      Value<int> id,
      required String sessionId,
      required int turnIndex,
      required String modelId,
      Value<bool> lightChat,
      required int sendToRequestMs,
      required int requestToFirstMs,
      required int firstTokenMs,
      required String outcome,
      required int createdAt,
    });
typedef $$ChatTurnSamplesTableUpdateCompanionBuilder =
    ChatTurnSamplesCompanion Function({
      Value<int> id,
      Value<String> sessionId,
      Value<int> turnIndex,
      Value<String> modelId,
      Value<bool> lightChat,
      Value<int> sendToRequestMs,
      Value<int> requestToFirstMs,
      Value<int> firstTokenMs,
      Value<String> outcome,
      Value<int> createdAt,
    });

class $$ChatTurnSamplesTableFilterComposer
    extends Composer<_$AppDatabase, $ChatTurnSamplesTable> {
  $$ChatTurnSamplesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get turnIndex => $composableBuilder(
    column: $table.turnIndex,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get modelId => $composableBuilder(
    column: $table.modelId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get lightChat => $composableBuilder(
    column: $table.lightChat,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get sendToRequestMs => $composableBuilder(
    column: $table.sendToRequestMs,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get requestToFirstMs => $composableBuilder(
    column: $table.requestToFirstMs,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get firstTokenMs => $composableBuilder(
    column: $table.firstTokenMs,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get outcome => $composableBuilder(
    column: $table.outcome,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ChatTurnSamplesTableOrderingComposer
    extends Composer<_$AppDatabase, $ChatTurnSamplesTable> {
  $$ChatTurnSamplesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get turnIndex => $composableBuilder(
    column: $table.turnIndex,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get modelId => $composableBuilder(
    column: $table.modelId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get lightChat => $composableBuilder(
    column: $table.lightChat,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get sendToRequestMs => $composableBuilder(
    column: $table.sendToRequestMs,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get requestToFirstMs => $composableBuilder(
    column: $table.requestToFirstMs,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get firstTokenMs => $composableBuilder(
    column: $table.firstTokenMs,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get outcome => $composableBuilder(
    column: $table.outcome,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ChatTurnSamplesTableAnnotationComposer
    extends Composer<_$AppDatabase, $ChatTurnSamplesTable> {
  $$ChatTurnSamplesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<int> get turnIndex =>
      $composableBuilder(column: $table.turnIndex, builder: (column) => column);

  GeneratedColumn<String> get modelId =>
      $composableBuilder(column: $table.modelId, builder: (column) => column);

  GeneratedColumn<bool> get lightChat =>
      $composableBuilder(column: $table.lightChat, builder: (column) => column);

  GeneratedColumn<int> get sendToRequestMs => $composableBuilder(
    column: $table.sendToRequestMs,
    builder: (column) => column,
  );

  GeneratedColumn<int> get requestToFirstMs => $composableBuilder(
    column: $table.requestToFirstMs,
    builder: (column) => column,
  );

  GeneratedColumn<int> get firstTokenMs => $composableBuilder(
    column: $table.firstTokenMs,
    builder: (column) => column,
  );

  GeneratedColumn<String> get outcome =>
      $composableBuilder(column: $table.outcome, builder: (column) => column);

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);
}

class $$ChatTurnSamplesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ChatTurnSamplesTable,
          ChatTurnSample,
          $$ChatTurnSamplesTableFilterComposer,
          $$ChatTurnSamplesTableOrderingComposer,
          $$ChatTurnSamplesTableAnnotationComposer,
          $$ChatTurnSamplesTableCreateCompanionBuilder,
          $$ChatTurnSamplesTableUpdateCompanionBuilder,
          (
            ChatTurnSample,
            BaseReferences<
              _$AppDatabase,
              $ChatTurnSamplesTable,
              ChatTurnSample
            >,
          ),
          ChatTurnSample,
          PrefetchHooks Function()
        > {
  $$ChatTurnSamplesTableTableManager(
    _$AppDatabase db,
    $ChatTurnSamplesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ChatTurnSamplesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ChatTurnSamplesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ChatTurnSamplesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<int> turnIndex = const Value.absent(),
                Value<String> modelId = const Value.absent(),
                Value<bool> lightChat = const Value.absent(),
                Value<int> sendToRequestMs = const Value.absent(),
                Value<int> requestToFirstMs = const Value.absent(),
                Value<int> firstTokenMs = const Value.absent(),
                Value<String> outcome = const Value.absent(),
                Value<int> createdAt = const Value.absent(),
              }) => ChatTurnSamplesCompanion(
                id: id,
                sessionId: sessionId,
                turnIndex: turnIndex,
                modelId: modelId,
                lightChat: lightChat,
                sendToRequestMs: sendToRequestMs,
                requestToFirstMs: requestToFirstMs,
                firstTokenMs: firstTokenMs,
                outcome: outcome,
                createdAt: createdAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String sessionId,
                required int turnIndex,
                required String modelId,
                Value<bool> lightChat = const Value.absent(),
                required int sendToRequestMs,
                required int requestToFirstMs,
                required int firstTokenMs,
                required String outcome,
                required int createdAt,
              }) => ChatTurnSamplesCompanion.insert(
                id: id,
                sessionId: sessionId,
                turnIndex: turnIndex,
                modelId: modelId,
                lightChat: lightChat,
                sendToRequestMs: sendToRequestMs,
                requestToFirstMs: requestToFirstMs,
                firstTokenMs: firstTokenMs,
                outcome: outcome,
                createdAt: createdAt,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ChatTurnSamplesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ChatTurnSamplesTable,
      ChatTurnSample,
      $$ChatTurnSamplesTableFilterComposer,
      $$ChatTurnSamplesTableOrderingComposer,
      $$ChatTurnSamplesTableAnnotationComposer,
      $$ChatTurnSamplesTableCreateCompanionBuilder,
      $$ChatTurnSamplesTableUpdateCompanionBuilder,
      (
        ChatTurnSample,
        BaseReferences<_$AppDatabase, $ChatTurnSamplesTable, ChatTurnSample>,
      ),
      ChatTurnSample,
      PrefetchHooks Function()
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$PairedDesktopsTableTableManager get pairedDesktops =>
      $$PairedDesktopsTableTableManager(_db, _db.pairedDesktops);
  $$SessionMirrorTableTableManager get sessionMirror =>
      $$SessionMirrorTableTableManager(_db, _db.sessionMirror);
  $$SessionEventsTableTableManager get sessionEvents =>
      $$SessionEventsTableTableManager(_db, _db.sessionEvents);
  $$InboxPendingTableTableManager get inboxPending =>
      $$InboxPendingTableTableManager(_db, _db.inboxPending);
  $$ChatTurnSamplesTableTableManager get chatTurnSamples =>
      $$ChatTurnSamplesTableTableManager(_db, _db.chatTurnSamples);
}
