/** The cockpit module of Rin: her own page, and a tile on the home page with what waits for the owner. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { AttentionTile, RinPage } from "./page.tsx";

export default definePlugin({
  id: "rin",
  setup(ctx) {
    ctx.pages.add({ path: "/rin", title: "Рин", nav: { order: 10 }, component: RinPage });
    ctx.slots.register("home.tile", { key: "rin-attention", component: AttentionTile });
  },
});
