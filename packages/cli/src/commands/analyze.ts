import { stubCommand } from './stub';

export const analyzeCommand = stubCommand({
  name: 'analyze',
  description: '分析界面源图，生成候选区域与证据',
});
