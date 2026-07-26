export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.WELDALL_DEPLOYMENT_MODE === "production") {
    const { prepareProductionDatabase } = await import("./server/deployment");
    await prepareProductionDatabase();
  }

  const email = process.env.WELDALL_BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (!email) return;

  const { bootstrapAdmin } = await import("./server/admin/service");
  const assignment = await bootstrapAdmin(email);
  console.log(
    `Administrator bootstrap complete for ${assignment.email} (version ${assignment.version}).`,
  );
}
