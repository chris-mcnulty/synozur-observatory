import { useState } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { BookMarked, Loader2, ChevronDown, ChevronRight, Search } from "lucide-react";

interface Framework {
  id: string;
  name: string;
  version: string | null;
  category: string;
  description: string | null;
  publisher: string | null;
  controlCount: number;
}

interface Control {
  id: string;
  controlId: string;
  title: string;
  description: string | null;
  category: string | null;
  level: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  accessibility: "Accessibility",
  security: "Security",
  privacy: "Privacy",
  ai: "AI Governance",
  compliance: "Compliance",
};

function FrameworkCard({ framework }: { framework: Framework }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<{ controls: Control[] }>({
    queryKey: [`/api/observatory/frameworks/${framework.id}/controls`],
    enabled: expanded,
  });
  const controls = Array.isArray(data?.controls) ? data.controls : [];

  const filtered = (controls ?? []).filter(
    (c) =>
      !search.trim() ||
      c.controlId.toLowerCase().includes(search.toLowerCase()) ||
      c.title.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Card data-testid={`card-framework-${framework.id}`}>
      <CardHeader className="cursor-pointer" onClick={() => setExpanded(!expanded)} data-testid={`button-toggle-framework-${framework.id}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <div className="min-w-0">
              <CardTitle className="text-base">
                {framework.name}
                {framework.version ? <span className="text-muted-foreground font-normal"> {framework.version}</span> : null}
              </CardTitle>
              {framework.description && <CardDescription className="mt-1">{framework.description}</CardDescription>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="secondary" className="text-xs">{CATEGORY_LABELS[framework.category] ?? framework.category}</Badge>
            <Badge variant="outline" className="text-xs">{framework.controlCount} controls</Badge>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Filter controls…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              data-testid={`input-filter-controls-${framework.id}`}
            />
          </div>
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">No controls match.</p>
          ) : (
            <div className="space-y-1">
              {filtered.map((c) => (
                <div key={c.id} className="border border-border rounded-md px-3 py-2" data-testid={`row-control-${c.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-sm">{c.controlId} — {c.title}</p>
                    {c.level && <Badge variant="outline" className="text-xs shrink-0">{c.level}</Badge>}
                  </div>
                  {c.description && <p className="text-xs text-muted-foreground mt-1">{c.description}</p>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function ObservatoryStandards() {
  const { data: frameworks, isLoading } = useQuery<Framework[]>({ queryKey: ["/api/observatory/frameworks"] });

  const byCategory = new Map<string, Framework[]>();
  for (const f of frameworks ?? []) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  const categoryOrder = ["accessibility", "security", "privacy", "ai", "compliance"];
  const orderedCategories = [
    ...categoryOrder.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !categoryOrder.includes(c)),
  ];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-standards-title">Standards Library</h1>
          <p className="text-muted-foreground text-sm mt-1">
            The frameworks and controls Observatory assesses against — link findings and evidence to controls for full traceability.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (frameworks ?? []).length === 0 ? (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center gap-3">
              <BookMarked className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">No frameworks loaded</p>
              <p className="text-sm text-muted-foreground">The standards catalog seeds automatically on server start.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {orderedCategories.map((cat) => (
              <div key={cat} className="space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{CATEGORY_LABELS[cat] ?? cat}</h2>
                {(byCategory.get(cat) ?? []).map((f) => (
                  <FrameworkCard key={f.id} framework={f} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
