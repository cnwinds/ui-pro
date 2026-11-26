import { stubCommand } from './stub';

export const verifyCommand = stubCommand({
  name: 'verify',
  description: '跑质量门禁：重组图与基准图比对、显隐测试、规则一致等',
});
