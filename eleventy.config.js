export default function (eleventyConfig) {
  eleventyConfig.addFilter("nextReadingLinks", (items, currentUrl) => {
    const current = items.findIndex((item) => item.url === currentUrl);
    if (current === -1) return items.slice(0, 2);
    return [...items.slice(current + 1), ...items.slice(0, current)].slice(0, 2);
  });
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addWatchTarget("src/assets/");
  return {
    dir: {
      input: "src",
      output: "_site"
    }
  };
}
