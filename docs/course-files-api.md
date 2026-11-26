# 学习资料文件 API

网页入口为 `/files`。API 与网站共用 HTTPS 443。浏览器使用站点登录会话；脚本可以使用站点已配置的移动 API Token 作为 Bearer。以下命令中的 `BASE` 是网站地址，`TOKEN` 应从自己的凭据管理器提供。上传须携带网站的 Origin。

```sh
curl --fail-with-body -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/files"
curl --fail-with-body -H "Authorization: Bearer $TOKEN" -H "Origin: $BASE" \
  -F "courseId=443350" -F "folderPath=习题/第1周" -F "file=@notes.pdf" "$BASE/api/v1/files"
```

根目录返回课程。跟随节点的 `childrenUrl` 读取课程或课次，内嵌的 `children` 是已列出的子目录。文件的 `downloadUrl` 是站内路径。响应中的 `publishedAt` 为原始录像发布时间（Unix 秒）。未标注课次的资料保留在课程资料目录。

上传返回 201 和文件标识、存储目录、下载路径。省略课程会归入“未分课程”。单文件上限 50 MiB。PDF、Word、TXT、MD、PNG、JPG、WebP 进入现有资料索引，其他文件按原始字节保存并可下载。相同课程、目录、文件名和内容的重复提交返回相同标识。内容不同会保留独立版本。

```sh
curl --fail --location -H "Authorization: Bearer $TOKEN" "$BASE$DOWNLOAD_URL" -o "$LOCAL_FILE"
```

使用支持跨主机重定向时自动移除 Authorization 的 curl，不启用 `--location-trusted`。录像将跳转到短期 R2 地址，过期后重新请求站内下载链接。文件树按学习资料目录和已验证录像清单生成，用户输入的目录只用作资料库标签。备份、配置文件和服务器其他项目没有文件树入口。
