# DeepSeek V4 Pro 灰测思维链 · 精炼资产库

> 来源：`C:\Users\Administrator\Downloads\grey test`
> 方法：按《V4 Pro 顶尖思维链逆向工程与资产转化指南》提纯
> 原则：不抄代码，只提因果；不建清单，只立结构；区分物理直觉与环境妥协

---

## 1. session-079907cb — WebGL2 FPV 花飞模拟器（手写物理+渲染+后处理+测试闭环）

### timeline
- 公理期：零第三方依赖单文件；SO(3) 指数映射+Rodrigues+周期 Gram-Schmidt；1/480s 固定步长
- 骨架期：IIFE 模块（math/input/physics/world/renderer/ui）；几何生成器+实例化渲染+程序化材质/天空/阴影/后处理
- 物理期：X-quad 混控矩阵、clamp 后反算真实推力/力矩、airmode 饱和；半隐式 Euler；broadphase 包围球
- 校准期：FSPL+margin 调图传衰减；LOS 用穿越厚度×dB/m；修 auto-land 符号/电池压降/油门曲线/ACRO 阻尼
- 闭环期：CDP 无头 Chrome+SwiftShader；修 8 弧度当 8 度、GLSL 保留字、垂直翻转、复位穿地；100k 步 SO(3) 稳定

### mentalAssertions（节选）
- "addBox expects radians, not degrees... 8 radians ≈ 98°" —— 参数单位契约
- "drone starts at [52,-2,4], physics keeps running while disarmed..." —— 测试前提自我否定
- "scale penalty by thickness traversed... 3 dB per meter" —— 二元直觉升级为连续物理量
- "shadow bias... 0.1m peter-panning acceptable for 12cm drone" —— 按世界尺度接受可容忍伪影

### reusableSchemas
- SO(3) 积分图式；物理求解器图式（固定步长 accumulator、半隐式 Euler、broadphase）；作动器混控图式；信号/渲染图式（FSPL+margin、LOS 厚度×dB/m、自适应采样密度）

### actionablePatches
- DETAIL_GUIDE：角度单位契约（旋转参数统一弧度，附 8 rad≈98° 检查）
- studio-pbr：阴影 bias 用世界米数/texel 斜率，小物件允许 0.1m peter-panning
- assertion：控制器符号断言（auto-land 负反馈、DROP 电机命令=0）
- assertion：ACRO 满偏扭矩预算断言（阻尼≤25% 力矩、稳态误差<5%）

---

## 2. session-1219f105 — 3D 体素中国寺庙（复杂工程）

### timeline
- 公理期：Y-up/+Z 中轴、180×220 场地、30-60fps、file:// 单文件；体素+按材质合并几何+每面可见性发射
- 骨架期：VoxelWorld packed Map、fill/ring/sym API；台基/庑殿/歇山/攒尖/裙檐；smoke test
- 性能期：623k→445k triangles；外空气 BFS+26 邻域膨胀 cull；typed array 填充
- 物理期：对称性翻车循环；Math.abs/对称中点取整/MirrorX/绝对噪声统一修复
- 取景期：相机从 bounding sphere 升级为关键点拟合+NDC bias+sky anchor
- 闭环期：ASCII/hue/luminance/debug probe/阴影开关诊断；ACES exposure 迭代

### mentalAssertions
- "先自我否定 shadow frustum 假说... 实际采样像素颜色" —— 怀疑测量工具
- "不用包住全包围盒，只包关键内容点" —— 构图裁剪
- "voxel 级结构对称 vs 图像对称 9.2% 不对称可接受" —— 分层断言
- "diminishing returns on photometric tuning... 0.36 reasonable" —— 主动止损

### reusableSchemas
- 对称性三层分离；可见性 flood-fill 剔面；内容感知相机拟合；ACES+按时段光照预算

### actionablePatches
- DETAIL_GUIDE：对称图案用 Math.abs(x)%step；配对道具 MirrorX；构图用关键点拟合
- studio-pbr：体素美术按晨昏/noon 给定量 sun/ambient/hemisphere 与 luminance 目标
- assertion：voxel 级对称只查非 foliage/cloud；图像级对称排除光照/随机并接受 9-10%

---

## 3. session-191083ea — 双叉臂悬架运动学仿真 HTML（工业 UI）

### timeline
- 公理期：毫米硬点表；X 侧向/Y 垂向/Z 前向；即时中心理论反推 camber 符号
- 物理期：解析求解（圆-球交集、A cosψ+B sinψ=C、Newton/secant）；有限差分派生 IC/RC/camber gain
- 骨架期：单 canvas 四视图 CAE；核心求解器抽无 DOM 纯函数
- 调参期：bump steer 1.6→0.95°/100mm；Ackermann→54.5%；行程 ±176→±80mm
- 闭环期：ResizeObserver 清 canvas + headless rAF 2Hz；改为 resize 同步 redrawNow

### mentalAssertions
- "上臂斜率直觉与 F1 负 camber gain 矛盾" —— 放弃直觉改用即时中心
- "PBD 有顺序/振荡风险 → 闭合形式解析解" —— 提前规避收敛翻车
- "轮胎在 Y-Z 平面塌成竖线是正确投影，不是 bug" —— 证伪视觉误报
- "ResizeObserver 在 rAF 后清屏" —— headless 噪声 vs 真缺陷分离

### reusableSchemas
- 闭合三角约束求解；有限差分运动学派生；多视图 CAE 渲染；无头验证隔离

### actionablePatches
- DETAIL_GUIDE：canvas 工程 resize 回调必须同步 redrawNow；headless rAF 可能 2Hz
- DETAIL_GUIDE：多视图坐标左右手性显式标注
- assertion：刚体链接残差 <1e-9mm；Ackermann |steer|<1° 输出 '--' 并 clamp ±200

---

## 4. session-60d0baca — 生物安全防御教育单文件 Demo

### timeline
- 公理期：基因编辑演示需求 → 重构为生物安全防御教育
- 骨架期：BWC/历史案例/检测/BSL/测验；Tailwind/Chart.js/Lucide
- 物理期：SEIR 简化模型、检测延迟 0/3/7/14 对比、雷达归一化
- 闭环期：定位 addEventListener 第三参数 location.reload() 立即执行

### mentalAssertions
- 生成前主动划安全红线，拒绝可操作武器化细节
- "箭头函数简洁体+逗号表达式... 第三个实参立即求值" —— JS 参数解析陷阱
- 不止修 bug，选择无刷新重置的更好 UX

### reusableSchemas
- 双用途内容安全闸门；检测延迟流行病学模型；单文件 HTML 组件骨架；JS 参数解析陷阱

### actionablePatches
- DETAIL_GUIDE：敏感内容先输出安全边界与防御视角框架
- assertion：addEventListener 实参/箭头函数括号闭合检查；location.reload() 只在回调内
- studio-pbr：单文件 Demo 先固化视觉基调再写功能
- assertion：交付前 JS 语法校验与关键词扫描

---

## 5. session-6cf24800 — 3D 体素中式寺庙（Three.js + VoxelWorld）

### timeline
- 公理期：跨环境验证策略；体素世界/轴对称/性能预算
- 骨架期：InstancedMesh 自我推翻为面剔除 BufferGeometry+烘焙 AO
- 物理期：空间冲突推演；Lambert BRDF /π 反推强度；shadow camera updateProjectionMatrix
- 闭环期：ISO/ASCII/对称差分/runtime 静态检查；clean-room 交付验证

### mentalAssertions
- "面剔除比 67k 实例更好" —— 主动降级到更稳更省
- "底面向下邻居为空，底面被发射" —— 几何泄漏先于渲染发现
- "smoke test 确认 91k voxel，问题在投影方向" —— 数据断言否错方向
- "updateProjectionMatrix() 静默坑" —— 不掩盖真实行为
- "Lambert /π 需要 3x 光强" —— 离线推演亮度

### reusableSchemas
- 体素坐标数值键；面剔除+AO mesher；统一屋顶生成器；对称坐标生成器

### actionablePatches
- DETAIL_GUIDE：roof() 统一收缩策略；对称用 centered symmetric spread
- studio-pbr：Three.js Lambert 物理标定（亮度=albedo×(sun·NdotL+hemi+ambient)/π；目标 lit 0.85-1.0）
- assertion：smoke test 输出体素数/draw call/bbox/对称差分；ISO painter 排序

---

## 6. session-84bf7b45 — 3D 水体渲染 / 池核游戏

### timeline
- 公理期：从零实现单文件；WebGL2 光栅化+程序化纹理+CDP 截图
- 骨架期：2.5D wall-on-edge 网格、BSP 房间、双通道光照烘焙、水面多 pass
- 物理期：玩家碰撞/游泳/浮力；修水下穿底、FBO 反馈环水面不可见
- 闭环期：pixelStats+benchFrames QA；水区掩码校准；36 项问题收敛
- 收尾：白地板/池底消失根因（光照过曝+折射 fallback 深度语义/反射过强）

### mentalAssertions
- "water shader 绑定当前 FBO depth 作纹理 → 反馈环静默 no-op" —— GPU 静默失败
- "子代理不能隔离测试，核心自己写" —— 委派判据
- "QA 阈值是任意初值，先改进再校准" —— 不拿测试作弊
- "游泳模式没有地板碰撞" —— 物理模型缺陷
- "fallback 深度语义错误" —— 手推深度语义

### reusableSchemas
- Wall-on-edge 网格；动态水位预生成；平面反射；多 pass 水体管线（opaque→blit 副本→water pass）

### actionablePatches
- DETAIL_GUIDE：大面积近白材质必须有 grout/污渍/腰线结构
- studio-pbr：水面禁止采样当前绑定 FBO；opaque 后 blit sceneColor/depth 副本
- assertion：QA 用 water-mask 区域统计，不能只看全帧 mean
- assertion：性能断言用 rAF+gl.finish，不用 step() CPU 提交时间

---

## 7. session-861cc5d2 — Exit-8 风格恐怖走廊（Three.js 复杂工程）

### timeline
- 公理期：否定 flashlight 重复题材；选定 Exit-8 异常识别循环
- 公理期：180° 旋转对称双 lane 环+中央遮挡块；深度 lane 安全窗口重生成
- 骨架期：CT/CA/CW/CX/CG/FX 模块契约；segment 状态机；入口符号判定
- 物理期：8 点光池复用；irradiance 估算+像素统计把 mean luminance 从 ~20 调到 ~72
- 物理期：碰撞 union cluster+最小位移逃逸
- 闭环期：CDP QA+69 异常视觉回归；44 draw calls/368 triangles

### mentalAssertions
- "双面吊牌从 lane A 看 edge-on 不可见" —— 视线几何提前否定
- "updateRegion 在 simulate 内先于 tryRegen" —— 调用顺序根因
- "shader 时间动画是 flicker 主因" —— 渲染层归因
- "测试先 update 后 snapshot 导致设置被覆盖" —— 测试顺序
- "单遍 sequential push-out 推回已清除 solid" —— 碰撞解析升级

### reusableSchemas
- 180° 旋转对称环状走廊；入口符号状态机；固定点光池复用；视觉回归断言（静态+motion+max-cell diff）

### actionablePatches
- studio-pbr：物理点光强度按 candela/距离平方衰减；先 irradiance 估算再截图 mean luminance
- DETAIL_GUIDE：自定义 ShaderMaterial 必须 include colorspace_fragment 或显式 sRGB 转换
- assertion：视觉回归必须含 max-cell diff、clean 噪声地板、motion diff
- assertion：碰撞解析覆盖相邻 solid 交界；union cluster+最小位移+多 pass

---

## 8. session-bebd0652 — 单文件 Terraria 复刻（2D 沙盒）

### timeline
- 公理期：typed arrays 存 tile/wall/liquid/light；seed+diff 存档；worldgen 只用 seeded RNG
- 骨架期：十个 chunk；multi-tile anchor+frame；Node stub-DOM+rAF budget harness
- 物理期：四方向双次扫描 RGB 光传播；队列液体模拟；AABB 物理；50+ 断言
- 闭环期：压力测试；float 索引、随机 boss、测试污染等跨层 bug；boss 改确定性周期
- 收尾：全物品/全 tile/全 mob 暴力渲染；手感调校；130+ 断言回归

### mentalAssertions
- "distT float 当数组索引 → undefined 伪装成生成失败" —— 坐标纪律
- "night loop 跑了数千帧，fallenStar 已堆积" —— 测试污染
- "updateMouseWorld 每帧覆盖手写鼠标" —— 注入测试需逆算屏幕坐标
- "jumps < maxJumps-1 导致地面双跳失效" —— off-by-one 最小复现
- "随机 boss 小样本不可复现 → 确定性周期" —— 测试稳定性

### reusableSchemas
- seed+diff 存档；多通道光传播；队列液体；multi-tile 锚点

### actionablePatches
- DETAIL_GUIDE：tile 坐标统一 toTile() 强制整数化
- assertion：测试隔离（清空 items/mobs/液体/重建 changed/重置相机鼠标；注入坐标逆算屏幕）
- assertion：物理手感断言（jump 高度/fall damage/Hermes max speed）
- studio-pbr：lightmap 像素中心 (x0*TS-cam.x)*zoom，移除半 tile 偏移

---

## 9. session-d02c049c — WebGL 黑洞相对论渲染（ray-marching + HDR）

### timeline
- 公理期：WebGL2 RGBA16F 主路径；四 pass HDR；RK4+自适应步长；薄盘穿越采样；多普勒波束
- 骨架期：修正相机正交基/叉积；FBO 无需翻转；画质冲突；重构步长与早期逃逸
- 物理期·亮度：headless 像素诊断；理论投影角验证暗区=真阴影+内盘暗环
- 物理期·一致性：弃 drawImage ASCII 改 getImageData 直方图；修正多普勒旋向
- 闭环期：float/LDR 对比；清理误杀 Edge 副作用

### mentalAssertions
- "怀疑 drawImage 缩略 ASCII 不可靠" —— 先怀疑测量工具
- "暗区=真阴影+内盘暗环" —— 理论投影角拆分
- "cap 3.2 浪费外区步数，可放宽" —— 按弯曲度分配预算
- "噪声旋向与多普勒方向不一致" —— 叉积顺序校验
- "无差别 kill Edge 关掉了用户 GUI" —— 环境操作禁止项

### reusableSchemas
- HDR 后处理兼容阶梯（float→half→RGBA8+对数域）；自适应 ray-march 步长；薄盘穿越+相对论着色；无头视觉回归（getImageData 直方图+理论投影角）

### actionablePatches
- DETAIL_GUIDE：headless 诊断用全分辨率 getImageData，不用 drawImage 缩略 ASCII
- assertion：Doppler 亮侧与噪声/物质流旋向一致，cross(radial,up) 固定
- studio-pbr：RGBA8 对数域 bright pass 先缩 1/8 防截断
- DETAIL_GUIDE：诊断脚本不得无差别 kill 浏览器，用唯一 user-data-dir

---

## 10. session-e5efa23b — 3D 涡喷发动机剖面可视化（Three.js）

### timeline
- 公理期：单 HTML+r161、双转子、InstancedMesh、Lathe 剖面、粒子/流线、双语 HUD
- 骨架期：模块化拼接单文件生产链；headless-shell+CDP+ASCII 密度图
- 骨架期：叶型 twist/camber 参数化；CasingShell setSector 显式 cap；latheAxisX 坐标映射
- 物理期：station LUT 流场/热力学；CPU 粒子+shader 黑体色带；冷却气流/AB 喷管/激波
- 物理期：PBR 调试——全金属靠环境反射；暗 PMREM 导致金属发黑；重做亮 studio 环境
- 闭环期：自测矩阵；修复自检假 PASS、拾取混合、初始巡航、file:// 回退；620k 三角 60fps

### mentalAssertions
- "scene.environmentIntensity 是 r163，但我在 r161" —— 版本边界刹车
- "方向光对全金属只产生小高光，整体亮度来自环境" —— PBR 归因
- "放弃 clipping 楔形方案，改为几何重建+显式 cap" —— 确定性结构
- "hover 代理+click 真几何混合拾取" —— 性能/精度拆解
- "自检比较当前 state 而非变化量 → 假 PASS" —— 测试污染

### reusableSchemas
- 剖面壳体图式（Lathe+cap、latheAxisX）；叶片/转子性能图式（InstancedMesh+质量档）；流动可视化 LUT；PBR 影棚图式；拾取混合图式

### actionablePatches
- DETAIL_GUIDE：切割剖面用 LatheGeometry 重建+显式 cap，不用 clipIntersection
- studio-pbr：金属靠环境反射时环境图要亮；量化 env radiance 再补偿
- studio-pbr：亮 studio PMREM+5-6 灯+1.1-1.25 exposure
- assertion：自检捕获前状态并测量变化量；渲染自检用真实 mesh 射线验证 cutaway 可见

---

## 11. session-f978cfe1 — 朱雀三号 Y2 火箭发射/回收交互电影（Three.js）

### timeline
- 公理期：多源核实事实；区分已验证时间戳与仿真遥测；单 HTML 自包含；视觉压缩策略
- 骨架期：模块顺序 data→audio→textures→rocket→world→effects→camera→HUD→main；PBR 缓存/PMREM/InstancedMesh/mesh<800
- 物理期：铰链三角几何反推着陆腿；遥测表物理矛盾重构弹道；单一 θ(t)+π·flipK 姿态
- 闭环期：截图评审；修发射台遮挡、塔架比例、喷流过曝、接触阴影、镜头取景
- 交付期：全流程验证、grep 外链、HTTP 服务器、关闭浏览器释放资源

### mentalAssertions
- "F9 legs stow upward... rotate ~125° downward" —— 三角几何反推
- "setFromUnitVectors 对跖时轴翻转 → 单一角度程序" —— 抖动根因
- "下程 197km/170s 平均 1160m/s 不可能" —— 轨迹物理一致性
- "低太阳角阴影 1600m 外 → 抬升太阳到 17°" —— 物理正确 vs 画面有效
- "缩短裙段让喷口可见" —— 回到真实设计修正

### reusableSchemas
- 遥测-视觉解耦压缩；铰链三角几何反推；单一姿态角程序；轨迹物理一致性校验

### actionablePatches
- DETAIL_GUIDE：可动部件先建几何参数表（铰链高度/臂长/展开角/间隙公式）
- assertion：遥测表物理一致性（sqrt(vx²+vy²)≈v、下程终点=390km）
- assertion：姿态动画禁止对跖四元数 slerp；单一 θ(t)+π·flipK 数值求导断言
- studio-pbr：金属调优顺序 envMapIntensity→roughness→sun elevation；过曝喷流降 hot core

---

## 12. session-7a276a79 — 程序化 3D 世界 bugfix + headless QA（儿童泳池困人）

### timeline
- 根因定位：不可见地/天花板 → Node 逐三角形 cross product 验证 winding 反向
- 根因定位：泳池困人 → kids pool 深度/游泳阈值/step-up 组合无出口；corner off-by-one、riser 超限
- 系统性修复：forward/backward BFS trap 检测；贪心雕刻 stair chain；repairTraps 后重建 water bodies
- 玩家物理校准：waterDepth>0.35 climb assist；SWIM_LIP 0.10→0.22；浅水跳跃/step 平滑
- 道具遮挡：starting block 阻塞出口 → keepClear 出口 lane + clearEscapeProps
- Headless 收尾：rAF 在 virtual time 不触发 → setTimeout shim；几何证明为主、像素为辅

### mentalAssertions
- "cross product 确认 ceiling winding 反向被 cull" —— winding/culling 优先
- "corner off-by-one 让 stair 脱离墙" —— 空间坐标数值推演
- "水面阈值两侧 swim/land 分支振荡" —— 双端修复
- "图可达≠物理可达，decorate 道具阻挡" —— 抽象模型修正
- "headless virtual time 下 rAF 不触发" —— 环境 vs 业务分离

### reusableSchemas
- Winding normal-consistency proof；Bidirectional reachability trap analysis；Headless WebGL boot shim + deterministic probe；Conservative movement-constant calibration

### actionablePatches
- DETAIL_GUIDE：不可见水平面先查 winding/culling；Node 三角形法向验证
- DETAIL_GUIDE：池梯 tread 与 rim 对齐；riser≤0.40；keepClear；清理阻塞道具
- studio-pbr：ceiling 用 per-corner AO；HDR emissive 定量；stair tread 不再标水格
- assertion：法向一致性/可达性/可逃出口/headless rAF shim 四条回归

---

## 13. session-a3fe5733 — 单文件 Three.js 涡喷发动机交互可视化

### timeline
- 总体架构：沿 X 轴气路站；8 级压气机+2 级涡轮；InstancedMesh；楔形剖切/半剖/透明 ghost
- 叶型气动：速度三角形推导 stagger/camber 符号；chord/solidity/轴向投影；根/尖随 hub/tip 锥面函数化
- 热力循环：Cycle 站参数；粒子三路径；swirl profile+smoothstep；低转速 alpha gate；动态 substep
- 几何验证：verify.mjs 叶排不重叠、流道边界、轴对撞；per-mesh interval
- 渲染交互：studio 环境、金属材质、ACES、ShaderMaterial 粒子/火焰/尾焰；clipping/ghost/cut/explode
- Turn2 调试：headless 首帧；先疑 fog 后证伪；定位 String.replace `$'` 破坏 bundle

### mentalAssertions
- "flow turns toward concave side" —— 叶型因果模型收敛
- "相对/绝对参考系互检粒子穿叶片" —— 表观矛盾消解
- "axisymmetric 下 [x,r] 区间相交即碰撞" —— 确定性验证
- "fog:false 是无害 no-op，真 bug 是 String.replace" —— 主动证伪早期假设

### reusableSchemas
- BladeRowSignConvention；AxisymmetricInterferenceCheck；SelfContainedModuleBundling；HeadlessWebGLHarness

### actionablePatches
- DETAIL_GUIDE：叶片建模 chord/轴向投影/根尖随锥面插值；转子根嵌入 hub 下方
- studio-pbr：自定义 ShaderMaterial 显式 fog:false；点光按物理衰减反推强度
- assertion：构建产物断言作用于最终 HTML；禁止 String.replace 字符串替换，用 replacer function

---

## 14. session-ea174f3b — MES API 封装灰测（Java/Spring）

### timeline
- 环境勘察：读文档/MesService/pom；识别 JREBEL/Local/Dev 差异；run_code 批量探测
- 认证连通：Basic Auth taclink/taclink 直通；precheck 报订单不存在=环境数据问题；upload SUCCESS
- 测试策略：放弃 @SpringBootTest；反射注入测试配置；pom skipTests=true 用 main runner
- 封装测试：MesServiceTest 4/4 通过；真实 HTTPS 上传 SUCCESS；逻辑单测覆盖
- 用户路径：/draft/mes 临时接口；WebSecurityConfig 放行；服务未监听（JDWP suspend=y）
- 配置回填：application-dev/Local.properties 指向测试环境；GBK sed 保持编码；未验证项明确

### mentalAssertions
- "Basic Auth 不是 CAS；taclink/taclink 直通" —— 认证层账号角色区分
- "业务错误码≠封装失败" —— 环境数据与代码缺陷分离
- "测试环境不需 CAS，但不能外推生产" —— 短因果链限定
- "不动 pom skipTests，用 main 风格执行" —— 不污染他人文件
- "JDWP suspend=y 不能替用户 resume" —— 自主工作与环境阻塞切开

### reusableSchemas
- 分层验证 schema（连通→认证→封装直测→逻辑单测→全链路）；认证矩阵 schema；绕过 surefire 的 main runner schema；环境配置隔离 schema（反射注入+GBK sed）

### actionablePatches
- DETAIL_GUIDE：MES 封装测试指南（先探测认证、反射注入测试、precheck 断言到达业务层、upload 断言 SUCCESS）
- assertion：MesServiceTest 不要把业务错误码当封装失败；isCheckPassed 用 SUCCESS/ERROR/FAIL/null 矩阵
- DETAIL_GUIDE：配置回填 guide（测试环境 host/ports/账号；iconv 验证编码）
- assertion：DraftController 联调先确认 JDWP resume、JREBEL 热加载

---

# 跨样本归并 · 可落地补丁总表

## DETAIL_GUIDE 增补候选
1. 角度单位契约：场景 API 旋转参数统一弧度，先做 8 rad≈98° 级换算检查
2. 对称性写作：中心轴对称一律 Math.abs(x)%step / MirrorX / centered spread
3. 构图取景：关键点拟合代替全包围盒；排除近地角点；加 sky anchor/NDC bias
4. 不可见水平面：先查 winding/culling，Node 三角形法向验证，再查材质
5. 可动部件：先建几何参数表（铰链/臂长/展开角/间隙公式），再建模
6. 单文件 canvas：resize 回调同步 redrawNow；headless rAF 可能 2Hz
7. 切割剖面：LatheGeometry 重建+显式 cap，不用 clipIntersection
8. 叶片建模：chord/轴向投影/根尖随锥面插值
9. tile 坐标：统一 toTile() 强制整数化，防 float 索引静默 undefined
10. MES/集成测试：先探测认证矩阵，业务错误码≠封装失败

## studio-pbr（纯函数/模板）候选
1. 阴影 bias 世界米数化+按最小尺度自适应
2. 金属材质环境图亮度量化（env radiance→envMapIntensity/ACES 补偿）
3. 亮 studio PMREM 模板（亮灰基底+softbox+5-6 灯+exposure 1.1-1.25）
4. 水体多 pass 模板（opaque→blit 副本→water pass，禁止采样当前 FBO）
5. HDR 降级模板（RGBA8 对数域 bright 缩 1/8）
6. 点光强度按 candela/距离平方衰减反推
7. 自定义 ShaderMaterial 显式 fog:false / colorspace_fragment
8. lightmap 像素中心校正、per-corner AO、HDR emissive 定量

## assertion（验收门禁）候选
1. 对称性分层断言（voxel 级严格、图像级接受 9-10% 不对称）
2. 物理一致性断言（轨迹 sqrt(vx²+vy²)≈v、姿态无跳变、Ackermann 小角度输出 '--'）
3. 构建产物断言（最终 HTML 抽取 inline script byte-identical + node --check；禁止 String.replace）
4. 测试隔离断言（清场、重置相机/鼠标、注入坐标逆算屏幕）
5. 视觉回归断言（max-cell diff、clean 噪声地板、motion diff、water-mask）
6. 可达性断言（forward==backward BFS、可逃出口、riser≤0.40）
7. 性能断言（rAF+gl.finish、draw calls/triangles 预算）
8. MES 断言（upload code=SUCCESS、isCheckPassed 矩阵、业务错误码不判失败）
