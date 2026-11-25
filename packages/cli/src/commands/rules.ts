import { stubCommand } from './stub';

export const rulesCommand = stubCommand({
  name: 'rules',
  description: '规则的查看、解释与检查',
  subcommands: {
    list: '列出生效的规则',
    why: '解释某个节点为何命中某条规则',
    check: '按规则检查界面并报告违例',
    lint: '检查规则文件本身是否合法',
  },
});
