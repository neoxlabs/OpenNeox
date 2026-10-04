/**
 * SkillsScreen - 技能列表显示组件
 * 类似 Claude Code 的 /skills 命令界面
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  category?: string;
  aliases?: string[];
  source: 'builtin' | 'user' | 'workspace';
}

export interface SkillsScreenProps {
  skills: SkillInfo[];
  onClose: () => void;
  onSelectSkill?: (skillId: string) => void;
}

export const SkillsScreen: React.FC<SkillsScreenProps> = ({
  skills,
  onClose,
  onSelectSkill,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : skills.length - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => (prev < skills.length - 1 ? prev + 1 : 0));
      return;
    }

    if (key.return && skills.length > 0 && onSelectSkill) {
      onSelectSkill(skills[selectedIndex].id);
      onClose();
      return;
    }
  });

  // 按来源分组
  const builtinSkills = skills.filter(s => s.source === 'builtin');
  const userSkills = skills.filter(s => s.source === 'user');
  const workspaceSkills = skills.filter(s => s.source === 'workspace');

  const renderSkillItem = (skill: SkillInfo, index: number, isSelected: boolean) => {
    const aliasStr = skill.aliases?.length ? ` (${skill.aliases.join(', ')})` : '';
    return (
      <Box key={skill.id}>
        <Text color={isSelected ? 'cyan' : 'white'}>
          {isSelected ? '› ' : '  '}
        </Text>
        <Text color={isSelected ? 'cyan' : 'green'} bold={isSelected}>
          /{skill.id}
        </Text>
        <Text color={isSelected ? 'cyan' : 'gray'}>
          {aliasStr} - {skill.description}
        </Text>
      </Box>
    );
  };

  let globalIndex = 0;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color="blue" bold>/skills</Text>
      <Text dimColor>{'─'.repeat(40)}</Text>

      {skills.length === 0 ? (
        <Box flexDirection="column" marginY={1}>
          <Text color="yellow" bold>Skills</Text>
          <Text dimColor>No skills found</Text>
          <Text />
          <Text dimColor>Create skills in .neox/skills/ or ~/.neox/skills/</Text>
        </Box>
      ) : (
        <>
          {/* 内置技能 */}
          {builtinSkills.length > 0 && (
            <Box flexDirection="column" marginY={1}>
              <Text color="yellow" bold>Built-in Skills</Text>
              {builtinSkills.map((skill, i) => {
                const idx = globalIndex++;
                return renderSkillItem(skill, idx, idx === selectedIndex);
              })}
            </Box>
          )}

          {/* 用户技能 */}
          {userSkills.length > 0 && (
            <Box flexDirection="column" marginY={1}>
              <Text color="yellow" bold>User Skills (~/.neox/skills/)</Text>
              {userSkills.map((skill, i) => {
                const idx = globalIndex++;
                return renderSkillItem(skill, idx, idx === selectedIndex);
              })}
            </Box>
          )}

          {/* 工作区技能 */}
          {workspaceSkills.length > 0 && (
            <Box flexDirection="column" marginY={1}>
              <Text color="yellow" bold>Workspace Skills (.neox/skills/)</Text>
              {workspaceSkills.map((skill, i) => {
                const idx = globalIndex++;
                return renderSkillItem(skill, idx, idx === selectedIndex);
              })}
            </Box>
          )}
        </>
      )}

      <Text>{'─'.repeat(40)}</Text>
      <Text dimColor>
        {skills.length > 0
          ? '↑↓ select · Enter to use · escape to close'
          : 'escape to close'}
      </Text>
    </Box>
  );
};
