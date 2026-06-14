import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://robinfai.github.io/blog/",
    title: "Robin 的笔记",
    description: "用 AstroPaper 承载 Obsidian 写作流的个人博客。",
    author: "Robin",
    profile: "https://github.com/robinfai",
    ogImage: "default-og.jpg",
    lang: "zh-CN",
    timezone: "Asia/Shanghai",
    dir: "ltr",
  },
  posts: {
    perPage: 4,
    perIndex: 4,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: true,
      url: "https://github.com/robinfai/blog/edit/main/",
    },
    search: "pagefind",
    comments: {
      enabled: true,
      provider: "giscus",
      repo: "robinfai/blog",
      repoId: "R_kgDOKA0OfA",
      category: "Announcements",
      categoryId: "DIC_kwDOKA0OfM4C_HMr",
      mapping: "pathname",
      strict: true,
      reactionsEnabled: true,
      emitMetadata: false,
      inputPosition: "bottom",
      theme: "auto",
      lang: "zh-CN",
      loading: "lazy",
    },
  },
  socials: [
    { name: "github", url: "https://github.com/robinfai/blog" },
  ],
  shareLinks: [
    { name: "whatsapp", url: "https://wa.me/?text=" },
    { name: "facebook", url: "https://www.facebook.com/sharer.php?u=" },
    { name: "x",        url: "https://x.com/intent/post?url=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    { name: "pinterest", url: "https://pinterest.com/pin/create/button/?url=" },
    { name: "mail",     url: "mailto:?subject=See%20this%20post&body=" },
  ],
});
