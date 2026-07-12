document.getElementById("search-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("query-input") as HTMLInputElement;
  const loading = document.getElementById("loading") as HTMLDivElement;
  const resultsCard = document.getElementById("results-card") as HTMLDivElement;
  const alertDiv = document.getElementById("sanitized-alert") as HTMLDivElement;
  const answerContent = document.getElementById("answer-content") as HTMLDivElement;
  const latencyTag = document.getElementById("latency-tag") as HTMLSpanElement;

  if (!input.value.trim()) return;

  loading.classList.remove("hidden");
  resultsCard.classList.add("hidden");
  alertDiv.classList.add("hidden");

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(input.value.trim())}`);
    const data = await response.json() as {
      latencyMs: number;
      sanitizedQuery: string;
      originalQuery: string;
      response: string;
    };

    latencyTag.innerText = `Procesado en ${data.latencyMs}ms`;

    if (data.sanitizedQuery !== data.originalQuery) {
      alertDiv.innerText = `Su consulta fue anonimizada por seguridad: "${data.sanitizedQuery}"`;
      alertDiv.classList.remove("hidden");
    }

    answerContent.innerText = data.response;
    resultsCard.classList.remove("hidden");
  } catch {
    answerContent.innerText = "Error procesando la consulta. Intente nuevamente.";
    resultsCard.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
});
