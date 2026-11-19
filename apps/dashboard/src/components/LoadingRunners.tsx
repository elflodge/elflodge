export function LoadingRunners() {
  return (
    <>
      <div class="head">
        <h1>Runners</h1>
        <div class="controls">
          <button class="primary" type="button" disabled>
            Add Runner
          </button>
        </div>
      </div>
      <ul class="runners" aria-busy="true">
        {Array.from({ length: 3 }, () => (
          <li class="runner" aria-hidden="true">
            <div>
              <span class="sk is-title" />
              <span class="sk is-short" />
            </div>
            <div>
              <span class="sk" />
              <span class="sk is-part" />
              <span class="sk is-part" />
            </div>
          </li>
        ))}
      </ul>
      <p class="vh" role="status">
        Loading Runners
      </p>
    </>
  );
}
