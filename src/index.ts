import { app } from "./app.ts";

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Ruddhaa accounting-core backend listening on port ${port}`);
});
