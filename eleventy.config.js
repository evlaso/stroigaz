export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addWatchTarget("src/assets/");
  return {
    dir: {
      input: "src",
      output: "_site"
    }
  };
}
