import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Asset, PolicyEvent } from "./types.js";
import { load, save, genId, now } from "./store.js";
import { formatAsset } from "./format.js";

export function registerAssetTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "asset_add",
    label: "Asset: Add",
    description: "Add a reusable asset (policy/rule/snippet). Use project_tool_docs('asset_add') for full usage.",
    parameters: Type.Object({
      category_slug: Type.String({ description: "Category slug (e.g. 'tech-stack', 'policies', 'vision')" }),
      category_description: Type.Optional(Type.String({ description: "Category description (only needed if creating a new category)" })),
      title: Type.String({ description: "Short title" }),
      context: Type.String({ description: "AI-optimized description of WHEN to apply this asset. Freeform." }),
      body: Type.String({ description: "Full content — the actual policy/rule/spec/snippet" }),
      project: Type.Optional(Type.Boolean({ description: "If true, inject at session start as required context (default: false)" })),
      trigger_event: Type.Optional(Type.Union([
        Type.Literal("epic_create"), Type.Literal("epic_close"), Type.Literal("epic_advance"),
        Type.Literal("issue_create"), Type.Literal("issue_close"), Type.Literal("issue_advance"),
      ], { description: "If set, the asset body is injected as a directive when this event fires" })),
    }),
    async execute(_id, params) {
      const r = load();

      // Auto-create category
      let cat = r.categories.find((c) => c.slug === params.category_slug);
      if (!cat) {
        cat = { slug: params.category_slug, description: params.category_description || params.category_slug };
        r.categories.push(cat);
      } else if (params.category_description) {
        cat.description = params.category_description;
      }

      const asset: Asset = {
        id: genId(),
        categorySlug: params.category_slug,
        title: params.title,
        context: params.context,
        body: params.body,
        project: params.project || false,
        trigger: params.trigger_event ? { event: params.trigger_event as PolicyEvent } : undefined,
        sources: [],
        linkedEpicIds: [],
        linkedIssueIds: [],
        createdAt: now(),
        updatedAt: now(),
      };

      r.assets.push(asset);
      save(r);

      const flag = asset.project ? " 🌐 (project)" : "";
      const trigger = asset.trigger ? ` ⚡${asset.trigger.event}` : "";
      return { content: [{ type: "text", text: `📎 Added asset **${asset.id}** [${asset.categorySlug}]: ${asset.title}${flag}${trigger}` }] };
    },
  });

  pi.registerTool({
    name: "asset_show",
    label: "Asset: Show",
    description: "Show full asset details. Use project_tool_docs('asset_show') for usage.",
    parameters: Type.Object({ id: Type.String({ description: "Asset ID" }) }),
    async execute(_id, params) {
      const r = load();
      const asset = r.assets.find((a) => a.id === params.id);
      if (!asset) return { content: [{ type: "text", text: `Asset '${params.id}' not found.` }] };
      return { content: [{ type: "text", text: formatAsset(asset, true, r.epics, r.issues) }] };
    },
  });

  pi.registerTool({
    name: "asset_list",
    label: "Asset: List",
    description: "List assets by category. Use project_tool_docs('asset_list') for usage.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category slug" })),
    }),
    async execute(_id, params) {
      const r = load();
      let assets = r.assets;
      if (params.category) assets = assets.filter((a) => a.categorySlug === params.category);

      if (!assets.length) return { content: [{ type: "text", text: "No assets found." }] };

      // Group by category
      const byCategory = new Map<string, Asset[]>();
      for (const a of assets) {
        if (!byCategory.has(a.categorySlug)) byCategory.set(a.categorySlug, []);
        byCategory.get(a.categorySlug)!.push(a);
      }

      let out = `# 📎 Assets (${assets.length})\n`;
      for (const [slug, catAssets] of byCategory) {
        const cat = r.categories.find((c) => c.slug === slug);
        out += `\n## ${slug}${cat ? ` — ${cat.description}` : ""}\n`;
        for (const a of catAssets) out += `\n${formatAsset(a, false)}\n`;
      }
      return { content: [{ type: "text", text: out }] };
    },
  });

  pi.registerTool({
    name: "asset_update",
    label: "Asset: Update",
    description: "Update asset fields. Use project_tool_docs('asset_update') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Asset ID" }),
      title: Type.Optional(Type.String()),
      context: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      project: Type.Optional(Type.Boolean()),
      category_slug: Type.Optional(Type.String({ description: "Move to a different category (auto-creates if new)" })),
      trigger_event: Type.Optional(Type.Union([
        Type.Literal("epic_create"), Type.Literal("epic_close"), Type.Literal("epic_advance"),
        Type.Literal("issue_create"), Type.Literal("issue_close"), Type.Literal("issue_advance"),
        Type.Literal(""),
      ], { description: "Set policy trigger event (empty string to remove)" })),
    }),
    async execute(_id, params) {
      const r = load();
      const asset = r.assets.find((a) => a.id === params.id);
      if (!asset) return { content: [{ type: "text", text: `Asset '${params.id}' not found.` }] };

      if (params.title !== undefined) asset.title = params.title;
      if (params.context !== undefined) asset.context = params.context;
      if (params.body !== undefined) asset.body = params.body;
      if (params.project !== undefined) asset.project = params.project;
      if (params.trigger_event !== undefined) {
        asset.trigger = params.trigger_event ? { event: params.trigger_event as PolicyEvent } : undefined;
      }
      if (params.category_slug !== undefined) {
        if (!r.categories.find((c) => c.slug === params.category_slug)) {
          r.categories.push({ slug: params.category_slug, description: params.category_slug });
        }
        asset.categorySlug = params.category_slug;
      }
      asset.updatedAt = now();

      save(r);
      return { content: [{ type: "text", text: `✅ Updated asset **${asset.id}**: ${asset.title}` }] };
    },
  });

  pi.registerTool({
    name: "asset_link",
    label: "Asset: Link",
    description: "Link asset to epic/issue. Use project_tool_docs('asset_link') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Asset ID" }),
      epic_id: Type.Optional(Type.String({ description: "Epic ID to link to" })),
      issue_id: Type.Optional(Type.String({ description: "Issue ID to link to" })),
    }),
    async execute(_id, params) {
      const r = load();
      const asset = r.assets.find((a) => a.id === params.id);
      if (!asset) return { content: [{ type: "text", text: `Asset '${params.id}' not found.` }] };

      const linked: string[] = [];

      if (params.epic_id) {
        const epic = r.epics.find((e) => e.id === params.epic_id);
        if (!epic) return { content: [{ type: "text", text: `Epic '${params.epic_id}' not found.` }] };
        if (!asset.linkedEpicIds.includes(params.epic_id)) {
          asset.linkedEpicIds.push(params.epic_id);
          linked.push(`epic [${params.epic_id}] ${epic.title}`);
        }
      }

      if (params.issue_id) {
        const issue = r.issues.find((i) => i.id === params.issue_id);
        if (!issue) return { content: [{ type: "text", text: `Issue '${params.issue_id}' not found.` }] };
        if (!asset.linkedIssueIds.includes(params.issue_id)) {
          asset.linkedIssueIds.push(params.issue_id);
          linked.push(`issue [${params.issue_id}] ${issue.title}`);
        }
      }

      if (!linked.length) return { content: [{ type: "text", text: "Provide epic_id or issue_id to link." }] };

      asset.updatedAt = now();
      save(r);
      return { content: [{ type: "text", text: `🔗 Linked **${asset.title}** → ${linked.join(", ")}` }] };
    },
  });

  pi.registerTool({
    name: "asset_unlink",
    label: "Asset: Unlink",
    description: "Unlink asset from epic/issue. Use project_tool_docs('asset_unlink') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Asset ID" }),
      epic_id: Type.Optional(Type.String({ description: "Epic ID to unlink" })),
      issue_id: Type.Optional(Type.String({ description: "Issue ID to unlink" })),
    }),
    async execute(_id, params) {
      const r = load();
      const asset = r.assets.find((a) => a.id === params.id);
      if (!asset) return { content: [{ type: "text", text: `Asset '${params.id}' not found.` }] };

      const unlinked: string[] = [];

      if (params.epic_id) {
        const idx = asset.linkedEpicIds.indexOf(params.epic_id);
        if (idx >= 0) { asset.linkedEpicIds.splice(idx, 1); unlinked.push(`epic ${params.epic_id}`); }
      }

      if (params.issue_id) {
        const idx = asset.linkedIssueIds.indexOf(params.issue_id);
        if (idx >= 0) { asset.linkedIssueIds.splice(idx, 1); unlinked.push(`issue ${params.issue_id}`); }
      }

      if (!unlinked.length) return { content: [{ type: "text", text: "Nothing to unlink." }] };

      asset.updatedAt = now();
      save(r);
      return { content: [{ type: "text", text: `🔓 Unlinked **${asset.title}** from ${unlinked.join(", ")}` }] };
    },
  });

  pi.registerTool({
    name: "asset_categories",
    label: "Asset: Categories",
    description: "List asset categories. Use project_tool_docs('asset_categories') for usage.",
    parameters: Type.Object({}),
    async execute() {
      const r = load();
      if (!r.categories.length) return { content: [{ type: "text", text: "No categories yet. They are auto-created when you add an asset." }] };
      let out = "# 📁 Asset Categories\n";
      for (const c of r.categories) {
        const count = r.assets.filter((a) => a.categorySlug === c.slug).length;
        out += `\n- **${c.slug}** — ${c.description} (${count} assets)`;
      }
      return { content: [{ type: "text", text: out }] };
    },
  });

  pi.registerTool({
    name: "asset_source",
    label: "Asset: Add Source",
    description: "Add source (file/URL) to asset. Use project_tool_docs('asset_source') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Asset ID" }),
      type: Type.Union([Type.Literal("file"), Type.Literal("url")], { description: "Source type" }),
      path: Type.String({ description: "File path or URL" }),
      description: Type.String({ description: "What this source provides" }),
    }),
    async execute(_id, params) {
      const r = load();
      const asset = r.assets.find((a) => a.id === params.id);
      if (!asset) return { content: [{ type: "text", text: `Asset '${params.id}' not found.` }] };

      asset.sources.push({ type: params.type, path: params.path, description: params.description });
      asset.updatedAt = now();
      save(r);

      const icon = params.type === "file" ? "📄" : "🔗";
      return { content: [{ type: "text", text: `${icon} Added source to **${asset.title}**: ${params.path}` }] };
    },
  });
}
