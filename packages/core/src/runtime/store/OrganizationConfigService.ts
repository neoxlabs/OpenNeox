/**
 * OrganizationConfigService — .neox/organization.yaml 解析与同步
 * 
 * 用户可以在项目根目录的 .neox/organization.yaml 中定义固定的组织结构。
 * 此服务负责：
 * 1. 解析 YAML 配置文件
 * 2. 同步到 AgentRegistry (SQLite)
 * 3. 提供组织信息供 spawn 流程查询
 */

import * as fs from 'fs';
import * as path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { AgentRegistryStore, RegisterAgentOpts } from '../store/AgentRegistryStore.js';

// ============================================================================
// Types — organization.yaml 结构
// ============================================================================

export interface OrgConfig {
  version: number;
  name: string;
  departments: Record<string, DepartmentConfig>;
  defaults?: OrgDefaults;
}

export interface DepartmentConfig {
  lead?: MemberConfig;
  members?: MemberConfig[];
}

export interface MemberConfig {
  id?: string;
  role: string;
  model?: string;
  specialties?: string[];
}

export interface OrgDefaults {
  auto_assign?: boolean;         // 自动按 specialty 分配合适的 agent
  memory_retention?: string;     // 记忆保留时间 (如 "30d")
  max_concurrent?: number;       // 同时运行的最大 agent 数
}

// ============================================================================
// OrganizationConfigService
// ============================================================================

export class OrganizationConfigService {
  private workDir: string;
  private configPath: string;
  private _config: OrgConfig | null = null;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.configPath = path.join(workDir, '.neox', 'organization.yaml');
  }

  // ==========================================================================
  // 配置文件操作
  // ==========================================================================

  /** 检查配置文件是否存在 */
  hasConfig(): boolean {
    return fs.existsSync(this.configPath);
  }

  /** 获取配置文件路径 */
  getConfigPath(): string {
    return this.configPath;
  }

  /** 加载并解析配置文件 */
  loadConfig(): OrgConfig | null {
    if (!this.hasConfig()) return null;

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      // 简易 YAML 解析（不依赖 yaml 包，只支持基础结构）
      const config = this.parseSimpleYaml(content);
      this._config = config;
      cliLogger.info('ORG_CONFIG', `Loaded organization config: "${config.name}" with ${Object.keys(config.departments || {}).length} departments`);
      return config;
    } catch (err: any) {
      cliLogger.warn('ORG_CONFIG', `Failed to load ${this.configPath}: ${err.message}`);
      return null;
    }
  }

  /** 获取已加载的配置 */
  getConfig(): OrgConfig | null {
    return this._config;
  }

  /** 创建默认配置文件 */
  createDefaultConfig(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const defaultYaml = `# Neox Agent Organization
# 定义你的 AI 团队结构
# 每个成员有固定角色、模型配置和特长

version: 1
name: "Dev Team"

departments:
  engineering:
    lead:
      role: "技术负责人"
      model: ""
      specialties:
        - "架构设计"
        - "技术决策"
        - "代码审查"
    members:
      - id: "frontend-dev"
        role: "前端开发"
        specialties:
          - "React"
          - "TypeScript"
          - "CSS"
      - id: "backend-dev"
        role: "后端开发"
        specialties:
          - "Node.js"
          - "API设计"
          - "数据库"
      - id: "qa-engineer"
        role: "测试工程师"
        specialties:
          - "单元测试"
          - "E2E测试"

defaults:
  auto_assign: true
  memory_retention: "30d"
  max_concurrent: 4
`;

    fs.writeFileSync(this.configPath, defaultYaml, 'utf-8');
    cliLogger.info('ORG_CONFIG', `Created default config at ${this.configPath}`);
  }

  // ==========================================================================
  // 同步到 AgentRegistry
  // ==========================================================================

  /** 从 YAML 同步到 SQLite AgentRegistry */
  syncToRegistry(registry: AgentRegistryStore): number {
    const config = this.loadConfig();
    if (!config) return 0;

    const agents: RegisterAgentOpts[] = [];

    for (const [deptName, dept] of Object.entries(config.departments || {})) {
      // Lead
      if (dept.lead) {
        agents.push({
          id: dept.lead.id || `${deptName}-lead`,
          role: dept.lead.role,
          department: deptName,
          model: dept.lead.model || undefined,
          specialties: dept.lead.specialties,
          configSource: 'yaml',
        });
      }

      // Members
      for (const member of dept.members || []) {
        agents.push({
          id: member.id || `${deptName}-${member.role}`,
          role: member.role,
          department: deptName,
          model: member.model || undefined,
          specialties: member.specialties,
          configSource: 'yaml',
        });
      }
    }

    if (agents.length > 0) {
      registry.registerBatch(agents);
      cliLogger.info('ORG_CONFIG', `Synced ${agents.length} agents to registry`);
    }

    return agents.length;
  }

  // ==========================================================================
  // 查询辅助
  // ==========================================================================

  /** 列出所有部门 */
  listDepartments(): string[] {
    return Object.keys(this._config?.departments || {});
  }

  /** 获取部门配置 */
  getDepartment(name: string): DepartmentConfig | null {
    return this._config?.departments[name] || null;
  }

  /** 获取默认配置 */
  getDefaults(): OrgDefaults {
    return this._config?.defaults || {};
  }

  /** 解析记忆保留时间（转为毫秒） */
  getMemoryRetentionMs(): number {
    const retention = this._config?.defaults?.memory_retention || '30d';
    const match = retention.match(/^(\d+)(d|h|m)$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30 days
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      default: return 30 * 24 * 60 * 60 * 1000;
    }
  }

  // ==========================================================================
  // Internal — 简易 YAML 解析
  // ==========================================================================

  private parseSimpleYaml(content: string): OrgConfig {
    // 尝试使用 js-yaml（如果可用）
    try {
      const yaml = require('js-yaml');
      return yaml.load(content) as OrgConfig;
    } catch {
      // js-yaml 不可用时，尝试 JSON 格式（作为兼容）
      try {
        return JSON.parse(content) as OrgConfig;
      } catch {
        throw new Error('Unable to parse organization config (install js-yaml for YAML support)');
      }
    }
  }
}
