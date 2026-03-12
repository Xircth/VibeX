export type CommonsDefinition = {
  id: string;
  name: string;
  description?: string;
  prompt: string;
};

export const DEFAULT_COMMONS: CommonsDefinition[] = [
  {
    id: "project-go-microservice",
    name: "项目上下文（Go 微服务）",
    description: "Go + 微服务 + Kubernetes + Redis/MySQL",
    prompt: [
      "# Commons: 项目上下文",
      "- 编程语言：Go",
      "- 架构：微服务",
      "- 运行环境：Kubernetes",
      "- 场景：高并发",
      "- 组件：Redis、MySQL",
    ].join("\n"),
  },
  {
    id: "company-code-style",
    name: "公司代码规范",
    description: "统一错误处理与日志规范",
    prompt: [
      "# Commons: 公司代码规范",
      "- 禁止 panic",
      "- 所有 error 必须显式处理",
      "- 日志必须包含 trace_id",
    ].join("\n"),
  },
];
