"use client";
// Filter controls shared by list pages: 40px tall on phones, the console's 36px inline controls from `sm`.
// Callers set the width (phones usually give the search the rest of its line). Touch screens get 16px text
// from globals.css.
import { clsx } from "clsx";
import { Search, X } from "lucide-react";
import { Select, type SelectOption } from "@/components/select";

const BOX =
  "h-10 rounded-lg border border-line bg-panel text-[14px] text-fg outline-none transition-[border-color,box-shadow] duration-200 hover:border-line-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] sm:h-9";

export function SearchField({ value, onChange, label, placeholder = "Filter…", className }: { value: string; onChange(v: string): void; label: string; placeholder?: string; className?: string }) {
  return (
    <label className={clsx(BOX, "flex min-w-0 items-center gap-2 px-3", className)}>
      <Search className="size-3.5 flex-none text-fg-3" aria-hidden />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden" />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear filter" className="-mr-1.5 grid size-7 flex-none place-items-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

export function SelectField<V extends string>({ value, onChange, label, options, className }: { value: string; onChange(v: V): void; label: string; options: readonly SelectOption<V>[]; className?: string }) {
  return <Select value={value} onChange={onChange} options={options} aria-label={label} base={clsx(BOX, "min-w-0 px-2.5 focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]")} className={className} />;
}
