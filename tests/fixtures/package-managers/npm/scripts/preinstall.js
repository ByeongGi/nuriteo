if (process.env.NPM_FIXTURE_DELAY_PREINSTALL === "1") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
