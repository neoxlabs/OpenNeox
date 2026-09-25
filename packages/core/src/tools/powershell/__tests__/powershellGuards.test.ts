import { describe, it, expect } from 'vitest';
import {
  validatePowerShellForSandbox,
  analyzePowerShellRisks,
} from '../powershellGuards.js';

describe('validatePowerShellForSandbox', () => {
  it('returns null when sandbox is disabled', () => {
    expect(validatePowerShellForSandbox('Remove-Item *', false)).toBeNull();
  });

  it('allows read-only cmdlets in sandbox', () => {
    expect(validatePowerShellForSandbox('Get-ChildItem', true)).toBeNull();
    expect(validatePowerShellForSandbox('Get-Content file.txt', true)).toBeNull();
    expect(validatePowerShellForSandbox('Select-String "pattern" *.ts', true)).toBeNull();
    expect(validatePowerShellForSandbox('Test-Path ./file.txt', true)).toBeNull();
    expect(validatePowerShellForSandbox('Write-Output "hello"', true)).toBeNull();
  });

  it('blocks write cmdlets in sandbox', () => {
    expect(validatePowerShellForSandbox('Set-Content file.txt "data"', true)).toBeTruthy();
    expect(validatePowerShellForSandbox('Remove-Item file.txt', true)).toBeTruthy();
    expect(validatePowerShellForSandbox('New-Item -Type File test.txt', true)).toBeTruthy();
  });

  it('blocks subexpressions in sandbox', () => {
    expect(validatePowerShellForSandbox('Get-Content $(Get-Location)', true)).toBeTruthy();
  });

  it('blocks variable assignments in sandbox', () => {
    expect(validatePowerShellForSandbox('$x = Get-Content file.txt', true)).toBeTruthy();
    expect(validatePowerShellForSandbox('$env:PATH = "malicious"', true)).toBeTruthy();
  });

  it('allows aliases of safe cmdlets', () => {
    expect(validatePowerShellForSandbox('ls', true)).toBeNull();
    expect(validatePowerShellForSandbox('cat file.txt', true)).toBeNull();
    expect(validatePowerShellForSandbox('pwd', true)).toBeNull();
  });
});

describe('analyzePowerShellRisks', () => {
  it('detects recursive delete', () => {
    const risks = analyzePowerShellRisks('Remove-Item -Recurse ./dir');
    expect(risks.length).toBeGreaterThan(0);
    expect(risks[0].risks.some(r => r.includes('递归删除'))).toBe(true);
  });

  it('detects Invoke-Expression', () => {
    const risks = analyzePowerShellRisks('Invoke-Expression $cmd');
    expect(risks.length).toBeGreaterThan(0);
    expect(risks[0].risks.some(r => r.includes('Invoke-Expression'))).toBe(true);
  });

  it('detects git internal path writes', () => {
    const risks = analyzePowerShellRisks('Set-Content .git/config "evil"');
    expect(risks.length).toBeGreaterThan(0);
    expect(risks[0].risks.some(r => r.includes('Git'))).toBe(true);
  });

  it('returns empty for safe commands', () => {
    expect(analyzePowerShellRisks('Get-ChildItem')).toEqual([]);
    expect(analyzePowerShellRisks('Get-Content file.txt')).toEqual([]);
  });
});
