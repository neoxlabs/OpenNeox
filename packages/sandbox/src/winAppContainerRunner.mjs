#!/usr/bin/env node
/**
 * Win AppContainer runner — neox-sandbox `appcontainer` 后端 spawn 入口。
 *
 * argv:
 *   node winAppContainerRunner.mjs
 *     --profile=<name>
 *     --cwd=<dir>
 *     [--write-root=<dir>]...
 *     [--deny-write=<dir>]...
 *     [--net=none|localhost|all]
 *     -- <program> <args...>
 *
 * 依赖可选 koffi：CreateAppContainerProfile + CreateProcess(SECURITY_CAPABILITIES)。
 * write-root 用 icacls 授 AppContainer SID；(deny-write) 再 deny 写。
 * 失败时 exit 91/92/93，便于上层识别。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_NO_WINDOW = 0x08000000;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
const STARTF_USESTDHANDLES = 0x00000100;
const HANDLE_FLAG_INHERIT = 0x00000001;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const CREATE_ALWAYS = 2;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INFINITE = 0xffffffff;
const HR_ALREADY_EXISTS = 0x800700b7;
const S_OK = 0;

/** Well-known capability SIDs (Win8+). */
const CAP_INTERNET_CLIENT = 'S-1-15-3-1';
const CAP_INTERNET_CLIENT_SERVER = 'S-1-15-3-2';
const CAP_PRIVATE_NETWORK = 'S-1-15-3-3';
const SE_GROUP_ENABLED = 0x00000004;

function parseArgs(argv) {
  let cwd = process.cwd();
  let profile = '';
  let net = 'none';
  const writeRoots = [];
  const denyWrites = [];
  const rest = [];
  let seenSep = false;
  for (const a of argv) {
    if (!seenSep) {
      if (a === '--') {
        seenSep = true;
        continue;
      }
      if (a.startsWith('--cwd=')) {
        cwd = a.slice('--cwd='.length);
        continue;
      }
      if (a.startsWith('--profile=')) {
        profile = a.slice('--profile='.length);
        continue;
      }
      if (a.startsWith('--net=')) {
        net = a.slice('--net='.length);
        continue;
      }
      if (a.startsWith('--write-root=')) {
        writeRoots.push(a.slice('--write-root='.length));
        continue;
      }
      if (a.startsWith('--deny-write=')) {
        denyWrites.push(a.slice('--deny-write='.length));
        continue;
      }
      continue;
    }
    rest.push(a);
  }
  if (!seenSep || rest.length === 0 || !profile) {
    throw new Error(
      'usage: winAppContainerRunner.mjs --profile= --cwd= [--write-root=]... [--deny-write=]... [--net=] -- <program> <args...>',
    );
  }
  return { cwd, profile, net, writeRoots, denyWrites, program: rest[0], args: rest.slice(1) };
}

function loadKoffi() {
  try {
    return require('koffi');
  } catch {
    return null;
  }
}

function decodeWString(koffi, ptr) {
  const arr = koffi.decode(ptr, 'uint16', 512);
  let s = '';
  for (const c of arr) {
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function buildCapabilitySids(net) {
  if (net === 'all') {
    return [CAP_INTERNET_CLIENT, CAP_INTERNET_CLIENT_SERVER, CAP_PRIVATE_NETWORK];
  }
  if (net === 'localhost') {
    return [CAP_PRIVATE_NETWORK];
  }
  return [];
}

function quoteCmdArg(a) {
  if (!/[ \t"]/u.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

/** Skip posix leftovers (e.g. /private/tmp) from cross-platform policy on Win. */
function isUsableWinPath(p) {
  if (!p || typeof p !== 'string') return false;
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const koffi = loadKoffi();
  if (!koffi) {
    console.error('[winAppContainerRunner] koffi 不可用');
    process.exit(91);
  }

  const kernel32 = koffi.load('kernel32.dll');
  const userenv = koffi.load('userenv.dll');
  const advapi32 = koffi.load('advapi32.dll');

  const CreateAppContainerProfile = userenv.func(
    'long __stdcall CreateAppContainerProfile(str16 name, str16 display, str16 desc, void *caps, uint32 count, _Out_ void **ppsid)',
  );
  const DeriveAppContainerSidFromAppContainerName = userenv.func(
    'long __stdcall DeriveAppContainerSidFromAppContainerName(str16 name, _Out_ void **ppsid)',
  );
  const FreeSid = advapi32.func('void* __stdcall FreeSid(void *pSid)');
  const ConvertSidToStringSidW = advapi32.func(
    'bool __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)',
  );
  const ConvertStringSidToSidW = advapi32.func(
    'bool __stdcall ConvertStringSidToSidW(str16 str, _Out_ void **sid)',
  );
  const LocalFree = kernel32.func('void* __stdcall LocalFree(void *h)');
  const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
  const InitializeProcThreadAttributeList = kernel32.func(
    'bool __stdcall InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, _Inout_ size_t *size)',
  );
  const UpdateProcThreadAttribute = kernel32.func(
    'bool __stdcall UpdateProcThreadAttribute(void *list, uint32 flags, uintptr_t attr, void *value, size_t size, void *prev, void *retsize)',
  );
  const DeleteProcThreadAttributeList = kernel32.func(
    'void __stdcall DeleteProcThreadAttributeList(void *list)',
  );
  const CreateFileW = kernel32.func(
    'void* __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *sa, uint32 disp, uint32 attrs, void *template)',
  );
  const SetHandleInformation = kernel32.func(
    'bool __stdcall SetHandleInformation(void *h, uint32 mask, uint32 flags)',
  );
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
  const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void *h, uint32 ms)');
  const GetExitCodeProcess = kernel32.func('bool __stdcall GetExitCodeProcess(void *h, _Out_ uint32 *code)');
  const CreateProcessW = kernel32.func(
    'bool __stdcall CreateProcessW(str16 appName, _Inout_ str16 cmdLine, void *procAttr, void *threadAttr, bool inherit, uint32 creationFlags, void *env, str16 cwd, void *si, _Out_ void *pi)',
  );

  const SECURITY_CAPABILITIES = koffi.struct('SECURITY_CAPABILITIES', {
    AppContainerSid: 'void *',
    Capabilities: 'void *',
    CapabilityCount: 'uint32',
    Reserved: 'uint32',
  });
  const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', {
    Sid: 'void *',
    Attributes: 'uint32',
  });
  const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
    hProcess: 'void *',
    hThread: 'void *',
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  });
  const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: 'void *',
    bInheritHandle: 'bool',
  });

  // --- profile SID ---
  const sidOut = [null];
  let hr = CreateAppContainerProfile(opts.profile, opts.profile, opts.profile, null, 0, sidOut);
  if ((hr >>> 0) === HR_ALREADY_EXISTS) {
    hr = DeriveAppContainerSidFromAppContainerName(opts.profile, sidOut);
  }
  if ((hr | 0) !== S_OK) {
    console.error(`[winAppContainerRunner] profile failed hr=0x${(hr >>> 0).toString(16)}`);
    process.exit(92);
  }
  const appSid = sidOut[0];

  const sidStrOut = [null];
  if (!ConvertSidToStringSidW(appSid, sidStrOut)) {
    console.error('[winAppContainerRunner] ConvertSidToStringSidW failed', GetLastError());
    FreeSid(appSid);
    process.exit(92);
  }
  const sidStr = decodeWString(koffi, sidStrOut[0]);
  LocalFree(sidStrOut[0]);

  // --- ACE grants ---
  const roots = (opts.writeRoots.length > 0 ? opts.writeRoots : [opts.cwd]).filter(isUsableWinPath);
  for (const root of roots) {
    const isCwd = path.resolve(root).toLowerCase() === path.resolve(opts.cwd).toLowerCase();
    if (!fs.existsSync(root)) {
      if (!isCwd) continue;
      try {
        fs.mkdirSync(root, { recursive: true });
      } catch {
        continue;
      }
    }
    const r = spawnSync('icacls', [root, '/grant', `*${sidStr}:(OI)(CI)(F)`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) {
      console.error(`[winAppContainerRunner] icacls grant failed: ${root}`, r.stderr || r.stdout);
    }
  }
  for (const deny of opts.denyWrites.filter(isUsableWinPath)) {
    if (!fs.existsSync(deny)) continue;
    spawnSync('icacls', [deny, '/deny', `*${sidStr}:(OI)(CI)(W,D)`], {
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  // --- capability SIDs ---
  const capSidStrings = buildCapabilitySids(opts.net);
  const capSidPtrs = [];
  let capsBuf = null;
  let capCount = 0;
  if (capSidStrings.length > 0) {
    const entries = [];
    for (const s of capSidStrings) {
      const out = [null];
      if (!ConvertStringSidToSidW(s, out)) {
        console.error('[winAppContainerRunner] ConvertStringSidToSidW', s, GetLastError());
        continue;
      }
      capSidPtrs.push(out[0]);
      entries.push({ Sid: out[0], Attributes: SE_GROUP_ENABLED });
    }
    capCount = entries.length;
    if (capCount > 0) {
      const stride = koffi.sizeof(SID_AND_ATTRIBUTES);
      capsBuf = Buffer.alloc(stride * capCount);
      for (let i = 0; i < capCount; i++) {
        koffi.encode(capsBuf, i * stride, SID_AND_ATTRIBUTES, entries[i]);
      }
    }
  }

  const scBuf = Buffer.alloc(koffi.sizeof(SECURITY_CAPABILITIES));
  koffi.encode(scBuf, SECURITY_CAPABILITIES, {
    AppContainerSid: appSid,
    Capabilities: capsBuf,
    CapabilityCount: capCount,
    Reserved: 0,
  });

  // --- attribute list ---
  const sizePtr = [0n];
  InitializeProcThreadAttributeList(null, 1, 0, sizePtr);
  const listSize = Number(sizePtr[0]);
  const attrList = koffi.alloc('uint8', listSize);
  sizePtr[0] = BigInt(listSize);
  if (!InitializeProcThreadAttributeList(attrList, 1, 0, sizePtr)) {
    console.error('[winAppContainerRunner] InitializeProcThreadAttributeList', GetLastError());
    cleanup();
    process.exit(92);
  }
  if (
    !UpdateProcThreadAttribute(
      attrList,
      0,
      PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
      scBuf,
      scBuf.length,
      null,
      null,
    )
  ) {
    console.error('[winAppContainerRunner] UpdateProcThreadAttribute', GetLastError());
    DeleteProcThreadAttributeList(attrList);
    cleanup();
    process.exit(92);
  }

  // --- stdio via temp files (inheritable) ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-ac-io-'));
  const stdoutPath = path.join(tmpDir, 'stdout.txt');
  const stderrPath = path.join(tmpDir, 'stderr.txt');
  const sa = {
    nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
    lpSecurityDescriptor: null,
    bInheritHandle: true,
  };
  const saBuf = Buffer.alloc(koffi.sizeof(SECURITY_ATTRIBUTES));
  koffi.encode(saBuf, SECURITY_ATTRIBUTES, sa);

  const hOut = CreateFileW(
    stdoutPath,
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    saBuf,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  const hErr = CreateFileW(
    stderrPath,
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    saBuf,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  const outAddr = BigInt(koffi.address(hOut));
  const errAddr = BigInt(koffi.address(hErr));
  if (outAddr === 0xffffffffffffffffn || errAddr === 0xffffffffffffffffn) {
    console.error('[winAppContainerRunner] CreateFile stdio failed', GetLastError());
    DeleteProcThreadAttributeList(attrList);
    cleanup();
    process.exit(92);
  }
  SetHandleInformation(hOut, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  SetHandleInformation(hErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

  const siBuf = Buffer.alloc(112);
  siBuf.writeUInt32LE(112, 0);
  siBuf.writeUInt32LE(STARTF_USESTDHANDLES, 60);
  siBuf.writeBigUInt64LE(0n, 80);
  siBuf.writeBigUInt64LE(outAddr, 88);
  siBuf.writeBigUInt64LE(errAddr, 96);
  siBuf.writeBigUInt64LE(BigInt(koffi.address(attrList)), 104);

  const cmdline = [quoteCmdArg(opts.program), ...opts.args.map(quoteCmdArg)].join(' ');
  const piBuf = Buffer.alloc(koffi.sizeof(PROCESS_INFORMATION));

  const ok = CreateProcessW(
    opts.program,
    [cmdline],
    null,
    null,
    true,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
    null,
    opts.cwd,
    siBuf,
    piBuf,
  );

  if (!ok) {
    console.error('[winAppContainerRunner] CreateProcess failed', GetLastError());
    CloseHandle(hOut);
    CloseHandle(hErr);
    DeleteProcThreadAttributeList(attrList);
    cleanup();
    process.exit(93);
  }

  const pi = koffi.decode(piBuf, PROCESS_INFORMATION);
  WaitForSingleObject(pi.hProcess, INFINITE);
  const codeOut = [0];
  GetExitCodeProcess(pi.hProcess, codeOut);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  CloseHandle(hOut);
  CloseHandle(hErr);
  DeleteProcThreadAttributeList(attrList);

  try {
    const so = fs.readFileSync(stdoutPath);
    if (so.length) process.stdout.write(so);
  } catch {
    /* */
  }
  try {
    const se = fs.readFileSync(stderrPath);
    if (se.length) process.stderr.write(se);
  } catch {
    /* */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* */
  }

  cleanup();
  process.exit(typeof codeOut[0] === 'number' ? codeOut[0] : 1);

  function cleanup() {
    for (const p of capSidPtrs) {
      try {
        LocalFree(p);
      } catch {
        /* */
      }
    }
    try {
      FreeSid(appSid);
    } catch {
      /* */
    }
  }
}

try {
  main();
} catch (err) {
  console.error('[winAppContainerRunner]', err);
  process.exit(1);
}
