export interface RedPacket {
  id: number;
  name: string;
  avatar?: string;
}

// ---- 阶段二：红包名单（真实数据由此录入） ----
// 录入方式（二选一）：
//  1. 把 Excel 名单按下面格式逐条写入本数组；
//  2. 头像图片放入 public/images/avatars/<id>.jpg（或 .png），
//     并在对应条目填写 avatar 字段；不填则显示名字首字 + 彩色底。
export const RED_PACKETS: RedPacket[] = [
  // 示例（删除本行，替换为真实名单）：
  // { id: 0, name: '张三', avatar: `${import.meta.env.BASE_URL}images/avatars/0.jpg` },
];
