export interface Submission {
  id: number;
  title: string;
  author: string;
  username: string;
  desc: string;
  link: string;
  image: string;
}

const BASE = import.meta.env.BASE_URL;

export const SUBMISSIONS: Submission[] = [
  { id: 15, title: "月出南山", author: "Kenji", username: "kenji", desc: "在office 拍的哟", link: "https://pfotoo.com/#/submission/YURWSU5IM3pKNXhNelN5enA3QXExdz09", image: "images/submissions/月出南山.jpg" },
  { id: 14, title: "阖家团圆，中秋快乐", author: "Myra", username: "Myra", desc: "", link: "https://pfotoo.com/#/submission/WjR1Nmt1MCtyMWpBS1VpdC83dmUzQT09", image: "images/submissions/阖家团圆，中秋快乐.jpg" },
  { id: 13, title: "狮子头", author: "Stanven", username: "stanven", desc: "传统舞狮文化与捏捏泥相结合。看着简单，实际一点也不简单的制作方法", link: "https://pfotoo.com/#/submission/YWFvRW00M2hXT1lWWkxCY3pNbUFQUT09", image: "images/submissions/狮子头.jpg" },
  { id: 12, title: "小手捏月饼，满满中秋情", author: "Effy Wang & Tina Li", username: "Effy Wang", desc: "我和女儿一起捏了盒月饼，小小的月饼藏着美好的心愿。祝大家中秋团圆，喜乐安康！", link: "https://pfotoo.com/#/submission/VmZ4ajNSNnlKT3ArZGNzZXVtM0dkdz09", image: "images/submissions/小手捏月饼，满满中秋情.jpg" },
  { id: 11, title: "雁塔迎月圆", author: "Tracy", username: "Tracy", desc: "", link: "https://pfotoo.com/#/submission/a1REcHROM0Jqc3hKc0RNT01pdFZCUT09", image: "images/submissions/雁塔迎月圆.jpg" },
  { id: 10, title: "雾里看塔", author: "Sherry", username: "Sherry", desc: "记第一次登广州塔", link: "https://pfotoo.com/#/submission/bWFRN2gxQ3dJS3BTMmswKzN5ajJPQT09", image: "images/submissions/雾里看塔.jpg" },
  { id: 9, title: "长安一片月", author: "Amber", username: "未设置昵称Amber", desc: "", link: "https://pfotoo.com/#/submission/a3lRaVYzcVRFdVhYcVhDTFRjb0ZiZz09", image: "images/submissions/长安一片月.jpg" },
  { id: 8, title: "月圆羊城", author: "Leon", username: "Leon", desc: "皎洁的圆月在广州塔旁，照耀着花城大地，中秋节快乐！", link: "https://pfotoo.com/#/submission/QUdNUGxYb01IQnVRQWxLeTJZWm85QT09", image: "images/submissions/月圆羊城.jpg" },
  { id: 7, title: "Be water，My Friend", author: "Joyce", username: "Joyce", desc: "Respect to Bruce Lee", link: "https://pfotoo.com/#/submission/VkJmdWRydXROQUNTRE9QTnEzVjhHUT09", image: "images/submissions/Be water，My Friend.jpg" },
  { id: 6, title: "Firework and fire tower", author: "Teresa", username: "Teresa", desc: "", link: "https://pfotoo.com/#/submission/eUNQR3Y3MzdveEUrZmUyUTRiOEV2dz09", image: "images/submissions/Firework and fire tower.jpg" },
  { id: 5, title: "月亮与路灯", author: "Faye", username: "Faye", desc: "十五的月亮十六圆", link: "https://pfotoo.com/#/submission/Q3c3TnVFcUhuZnVrQVVrV3VRSFFqdz09", image: "images/submissions/月亮与路灯.jpg" },
  { id: 4, title: "Lion", author: "Alvin wang", username: "Alvin", desc: "Do you know where the lion is ?  Think about HSBC", link: "https://pfotoo.com/#/submission/ZkZybmFpVVkvNWlSUldkT2RQYk1qUT09", image: "images/submissions/Lion.jpg" },
  { id: 3, title: "醒醒目目", author: "醒醒目目", username: "Zu Shun", desc: "", link: "https://pfotoo.com/#/submission/d0REbWN6WXZ1MUU1TFZlTmZtckUvUT09", image: "images/submissions/醒醒目目.jpg" },
  { id: 2, title: "We are under the same moonlight", author: "miya luo", username: "miya", desc: "", link: "https://pfotoo.com/#/submission/Vy9qOTlTbHptZUw5ZEVWMXYwMjBvUT09", image: "images/submissions/We are under the same moonlight.jpg" },
  { id: 1, title: "手持醒狮", author: "Raymond Yuan", username: "Raymond", desc: "Raymond手持一只醒狮", link: "https://pfotoo.com/#/submission/eENFSVhHU21aa0ZDWU8vakJHUU56QT09", image: "images/submissions/手持醒狮.jpg" },
].map((s) => ({
  ...s,
  image: `${BASE}${s.image}`,
}));
