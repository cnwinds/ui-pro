import { stubCommand } from './stub';

export const skillCommand = stubCommand({
  name: 'skill',
  description: '技能说明：装进外部 Agent，或打印出来',
  subcommands: {
    install: '把技能说明装进 Cursor、Claude Code 等外部 Agent',
    show: '打印技能说明',
  },
});
