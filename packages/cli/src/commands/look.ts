import { stubCommand } from './stub';

export const lookCommand = stubCommand({
  name: 'look',
  description: '生成带标注的视图图片，供人或 agent 查看',
});
