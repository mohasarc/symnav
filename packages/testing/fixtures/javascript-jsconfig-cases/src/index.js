import { slugify } from "@/util";

export function title(text) {
  return slugify(text);
}
