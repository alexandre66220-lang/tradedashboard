import type { MetadataRoute } from "next";

// Lets the dashboard be added to a phone's home screen and opened like an app (no offline mode: the data is live).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Market Dashboard",
    short_name: "Marché",
    description: "Suivi de marché en lecture seule",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
