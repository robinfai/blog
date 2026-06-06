# Robin 的笔记

这个仓库使用 [AstroPaper](https://github.com/satnaing/astro-paper) 作为博客基线模板，源码放在 `main` 分支，静态构建结果发布到 `gh-pages` 分支。

## 本地运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

构建结果会输出到 `dist/`。当前站点按 GitHub Pages 项目页配置，访问路径是 `/blog/`。

## 内容

文章放在 `src/content/posts/`。当前已迁入：

- `src/content/posts/goal-long-running-task/long-running-goal-execution.md`

文章图片放在同级 `images/` 目录下，保持 Markdown 相对路径引用。
