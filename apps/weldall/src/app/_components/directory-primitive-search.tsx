"use client";

import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SVGProps } from "react";
import type { SearchablePrimitiveDto, SearchablePrimitiveType } from "@/lib/searchable-primitives";

interface PrimitiveSearchAuxiliaryData {
  description?: string;
  group: string;
  href: string;
  type: SearchablePrimitiveType;
  available?: boolean;
}

interface PrimitiveSearchItem extends SearchableItem<PrimitiveSearchAuxiliaryData> {
  auxiliaryData: PrimitiveSearchAuxiliaryData;
  searchText: string;
}

const groupLabels: Record<SearchablePrimitiveType, string> = {
  skill: "Skills",
  resource: "Resources",
  scope: "Scopes",
};

export function DirectoryPrimitiveSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchSource = useMemo(() => createPrimitiveSearchSource(setLoadError), []);

  useEffect(() => {
    const openFromKeyboard = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key.toLocaleLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }
      event.preventDefault();
      setIsOpen((current) => !current);
    };
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, []);

  const setOpen = (open: boolean) => {
    if (open) setLoadError(null);
    setIsOpen(open);
  };

  return (
    <>
      <button
        type="button"
        className="directory-search-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label="Search skills, resources, and scopes"
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
        <span className="directory-search-label">Search skills, resources, scopes</span>
        <kbd>⌘/Ctrl K</kbd>
      </button>
      <CommandPalette<PrimitiveSearchItem>
        isOpen={isOpen}
        onOpenChange={setOpen}
        onValueChange={(value) => {
          const item = searchSource.get(value);
          if (item) router.push(item.auxiliaryData.href);
        }}
        searchSource={searchSource}
        input={<CommandPaletteInput placeholder="Search skills, resources, and scopes" />}
        emptyBootstrapText={loadError ?? "No accessible primitives"}
        emptySearchText="No matching skills, resources, or scopes"
        label="Search skills, resources, and scopes"
        renderItem={(item) => (
          <div className="directory-search-result">
            <PrimitiveIcon type={item.auxiliaryData.type} />
            <span className="directory-search-result-copy">
              <span className="directory-search-result-title">{item.label}</span>
              {item.auxiliaryData.description ? (
                <span className="directory-search-result-description">
                  {item.auxiliaryData.description}
                </span>
              ) : null}
            </span>
            {item.auxiliaryData.available === false ? (
              <span className="directory-search-result-status">Missing scopes</span>
            ) : null}
          </div>
        )}
      />
    </>
  );
}

interface PrimitiveSearchSource extends SearchSource<PrimitiveSearchItem> {
  get(id: string): PrimitiveSearchItem | undefined;
}

export function createPrimitiveSearchSource(
  onError: (message: string | null) => void,
): PrimitiveSearchSource {
  let itemsPromise: Promise<PrimitiveSearchItem[]> | undefined;
  let itemsById = new Map<string, PrimitiveSearchItem>();

  const load = () => {
    itemsPromise ??= fetch("/api/directory/primitives", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Primitive search returned ${response.status}`);
        return (await response.json()) as SearchablePrimitiveDto[];
      })
      .then((primitives) => {
        const items = primitives.map(toSearchItem);
        itemsById = new Map(items.map((item) => [item.id, item]));
        onError(null);
        return items;
      })
      .catch(() => {
        itemsPromise = undefined;
        onError("Search is temporarily unavailable");
        return [];
      });
    return itemsPromise;
  };

  return {
    bootstrap: load,
    async search(query) {
      const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const items = await load();
      if (!terms.length) return items;
      return items.filter((item) => terms.every((term) => item.searchText.includes(term)));
    },
    get(id) {
      return itemsById.get(id);
    },
  };
}

function toSearchItem(primitive: SearchablePrimitiveDto): PrimitiveSearchItem {
  return {
    id: `${primitive.type}:${primitive.id}`,
    label: primitive.label,
    auxiliaryData: {
      type: primitive.type,
      group: groupLabels[primitive.type],
      href: primitiveHref(primitive),
      ...(primitive.description ? { description: primitive.description } : {}),
      ...(primitive.available !== undefined ? { available: primitive.available } : {}),
    },
    searchText: [
      primitive.label,
      primitive.id,
      primitive.description ?? "",
      ...(primitive.keywords ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase(),
  };
}

function primitiveHref(primitive: SearchablePrimitiveDto): string {
  const id = encodeURIComponent(primitive.id);
  if (primitive.type === "skill") return `/skill/${id}`;
  if (primitive.type === "resource") return `/resources?resource=${id}`;
  return `/scopes?scope=${id}`;
}

function PrimitiveIcon({ type }: { type: SearchablePrimitiveType }) {
  if (type === "resource") return <ResourceIcon />;
  if (type === "scope") return <ScopeIcon />;
  return <SkillIcon />;
}

type IconProps = SVGProps<SVGSVGElement>;

function IconBase(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </IconBase>
  );
}

function ResourceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
      <path d="m9 9 6 6" />
    </IconBase>
  );
}

function SkillIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </IconBase>
  );
}

function ScopeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 5h14v5H5zM5 14h14v5H5z" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </IconBase>
  );
}
