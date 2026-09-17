# ChatGPT / Codex 自动切换

在设置页连接本机 Codex 的 ChatGPT 账号，再开启自动切换。共用本机 Codex 登录，不复制登录令牌到浏览器，也不会在关闭切换时退出桌面账号。Codex 程序须在 PATH，或在服务配置指定可执行文件完整路径。

每个文本分析前读取额度，所有返回窗口取最低剩余值。大于 50% 使用 Codex；小于等于 50%、未登录、额度未知或生成失败时使用已配置的 OpenAI API Key。额度恢复后下次请求自动恢复 Codex。请求串行检查避免本站并发抢占，但其他客户端及当前请求仍可能使额度跌破 50%，不是硬性保留额度。API 按原有计费方式收费，不自动购买额度。

涵盖课程正文提取、课程问答和健康摘要。文件附件仍走 Responses API 上传及删除流程。API 文件 ID 不传给 Codex。健康摘要缓存继续按输入摘要复用。

Codex 使用临时线程、禁用环境访问及动态工具，拒绝所有服务端工具授权请求。只发送分析正文，不继承 Canvas/API 密钥环境变量。不宣称 Codex 具有 Responses API store:false 的数据保留语义。

连接通过本机 stdio，不暴露通用 RPC 到浏览器。网站端只提供 owner 验证和同源保护的登录/开关接口，以及脱敏额度状态。该集成依赖实验性 App Server 协议，部署到其他主机需要重新配置 Codex。

来源：https://learn.chatgpt.com/docs/app-server
