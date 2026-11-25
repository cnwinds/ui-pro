import { stubCommand } from './stub';

export const verifyCommand = stubCommand({
  name: 'verify',
  description: '渲染并与源图比对，运行质量门禁',
});
