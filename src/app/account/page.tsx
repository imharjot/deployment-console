import { redirect } from "next/navigation";

// Moved under Settings; old links and bookmarks still land there.
export default function Account() {
  redirect("/settings/account");
}
