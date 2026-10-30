/** 语义模型独立运行，避免 Windows 下两版 sharp/libvips 污染宿主 DLL。 */
import { pipeline } from '@huggingface/transformers';

const model = pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' });
// 父进程关闭后必须一起退出，避免模型进程遗留占用内存。
process.on('disconnect', () => process.exit(0));
process.on('message', async (message) => {
  try {
    const extractor = await model;
    const data = message.type === 'ready' ? null : Array.from((await extractor(
      String(message.text || '').slice(0, 400), { pooling: 'mean', normalize: true },
    )).data);
    if (process.connected) process.send({ id: message.id, data });
  } catch (error) {
    if (process.connected) process.send({ id: message.id, error: String(error.message || error) });
  }
});
// 初始化失败由 IPC 请求回报，避免尚未收到请求时触发未处理拒绝。
model.catch(() => {});
