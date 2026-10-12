import { useEffect, useRef, useState, type FormEvent } from "react";

import type { CreateThreadInput } from "../shared/types";
import { Icon } from "./icons";

interface CreateThreadDialogProps {
  defaultCwd: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: CreateThreadInput) => Promise<boolean>;
}

export function CreateThreadDialog({
  defaultCwd,
  busy,
  onClose,
  onCreate,
}: CreateThreadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    dialog.showModal();
    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) {
      setValidation("项目 cwd 不能为空");
      return;
    }
    if (!normalizedCwd.startsWith("/")) {
      setValidation("项目 cwd 必须是绝对路径");
      return;
    }

    setValidation(null);
    const input: CreateThreadInput = {
      cwd: normalizedCwd,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    };
    if (await onCreate(input)) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="create-thread-dialog"
      aria-labelledby="create-thread-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form method="dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <h2 id="create-thread-title">新建 Codex</h2>
            <p>从大屏创建并管理一个新的 Codex 会话。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <label>
          <span>项目 cwd</span>
          <input
            autoFocus
            required
            value={cwd}
            onChange={(event) => setCwd(event.currentTarget.value)}
            placeholder="/path/to/project"
          />
        </label>
        <label>
          <span>标题（可选）</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="便于在大屏识别这个会话"
          />
        </label>
        <label>
          <span>首条任务（可选）</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="创建后立即发送给 Codex"
          />
        </label>
        {validation ? <p className="dialog-validation">{validation}</p> : null}
        <footer>
          <button className="dialog-cancel" type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="dialog-create" type="submit" disabled={busy || !cwd.trim()}>
            <Icon name="plus" />
            <span>{busy ? "正在创建" : "新建 Codex"}</span>
          </button>
        </footer>
      </form>
    </dialog>
  );
}
