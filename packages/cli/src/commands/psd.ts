import { stubCommand } from './stub';

export const psdCommand = stubCommand({
  name: 'psd',
  description: 'PSD 源文件相关检查',
  subcommands: { lint: '检查 PSD 的图层命名与结构是否符合交付规范' },
});
