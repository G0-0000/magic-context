/** Empty payloads are boundary-only markers for raw rows excluded by historian filters, not summaries. */
export function isNoContentCompartment(row: {
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
}): boolean {
    return [row.title, row.content, row.p1, row.p2, row.p3, row.p4].every((value) => !value);
}

/** SQL equivalent for readers that count summary rows without loading their payloads. */
export const HAS_COMPARTMENT_CONTENT_SQL =
    "(title <> '' OR content <> '' OR COALESCE(p1, '') <> '' OR COALESCE(p2, '') <> '' OR COALESCE(p3, '') <> '' OR COALESCE(p4, '') <> '')";
