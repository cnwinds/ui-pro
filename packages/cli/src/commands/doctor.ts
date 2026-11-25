import { stubCommand } from './stub';

export const doctorCommand = stubCommand({
  name: 'doctor',
  description: '检查本机环境（Godot、字体、图像库等）是否满足要求',
});
