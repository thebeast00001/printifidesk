import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Print Counter",
    short_name: "Print",
    description: "Upload from your phone, pay with UPI, collect a printed set.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#edebe6",
    theme_color: "#edebe6",
  };
}
