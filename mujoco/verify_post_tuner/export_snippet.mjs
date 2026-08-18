// 由 viewer 的「機器人崗位微調」匯出(§18)。貼回 traffic_director.js
// 的 KBOT_POSTS_DEFAULT,並同步下列鏡像,否則 node 測試會綠著騙人:
//   mujoco/test_v4_direction_and_turns.mjs 的 POSTS
//   SPEC_VIEWER_V2.md 的崗位座標表
// 改完務必跑 python3 mujoco/stamp_versions.py。
const KBOT_POSTS_DEFAULT = Object.freeze({
  stand: Object.freeze({
    id: "stand", label: "行穿線旁人行道", x: 11.00, y: 0.24, z: 17.15,
  }),
  crosswalk: Object.freeze({
    id: "crosswalk", label: "行穿線中央", x: 15.00, y: 0.02, z: 8.33,
  }),
  lane90: Object.freeze({
    id: "lane90", label: "巷90 巷口", x: -3.50, y: 0.30, z: 17.00,
  }),
});
