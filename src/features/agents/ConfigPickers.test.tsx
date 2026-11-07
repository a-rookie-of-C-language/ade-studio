import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "@/bindings";
import { ConfigPickers, configPickerOptions } from "./ConfigPickers";
import { useAgents } from "./store";

const config = (values: AgentConfigOption["values"], category = "model"): AgentConfigOption => ({
  id: "model",
  name: "Model",
  category,
  description: null,
  current: null,
  via: "option",
  values,
});
const value = (id: string, name = id, description: string | null = null) => ({ value: id, name, description });

describe("configPickerOptions", () => {
  it("groups nested paths by their first provider and preserves the full value and description", () => {
    expect(configPickerOptions(config([value("9router/cmc/Beam", "Beam display", "Fast")]))).toEqual([
      { value: "9router", label: "9router", section: true },
      { value: "9router/cmc/Beam", label: "Beam", detail: "cmc/Beam · Fast", keywords: "9router" },
    ]);
  });
  it("keeps plain ids ungrouped even when the display name contains a slash", () => {
    expect(configPickerOptions(config([value("plain", "Local / Beam", "Offline")]))).toEqual([
      { value: "plain", label: "Local / Beam", detail: "Offline", keywords: "" },
    ]);
  });
  it("collects several providers in encounter order and preserves order inside each group", () => {
    const options = configPickerOptions(
      config([value("a/One"), value("b/Two"), value("a/Three"), value("plain"), value("__section__:a")]),
    );
    expect(options.map((o) => [o.value, !!o.section])).toEqual([
      ["plain", false],
      ["__section__:a", false],
      ["a", true],
      ["a/One", false],
      ["a/Three", false],
      ["b", true],
      ["b/Two", false],
    ]);
    expect(options[3]?.detail).toBe("One");
  });
  it("leaves non-model option labels and descriptions intact", () => {
    expect(configPickerOptions(config([value("a/One", "Custom", "Description")], "mode"))).toEqual([
      { value: "a/One", label: "Custom", detail: "Description" },
    ]);
  });
});

it("shows Cursor approvals separately from its execution mode and sends the choice", () => {
  const option = (id: string, category: string, values: string[]): AgentConfigOption => ({
    id,
    category,
    name: category === "approval" ? "Approvals" : "Mode",
    description: null,
    via: "option",
    current: values[0]!,
    values: values.map((value) => ({
      value,
      name: value === "bypass" ? "Bypass approvals" : value,
      description: null,
    })),
  });
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        option("mode", "mode", ["Agent", "Plan", "Ask"]),
        option("openidea.cursor.approval", "approval", ["ask", "bypass"]),
      ]}
      provider="copilot"
      onChange={onChange}
    />,
  );
  expect(screen.getByText("Agent")).toBeVisible();
  fireEvent.click(screen.getByLabelText("Approvals"));
  fireEvent.click(screen.getByRole("option", { name: "Bypass approvals" }));
  expect(onChange).toHaveBeenCalledWith("openidea.cursor.approval", "bypass");
});

it("shows Allow All as a switch and sends on/off values", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        {
          id: "allow_all",
          name: "Allow All",
          category: "permissions",
          description: null,
          current: "off",
          via: "option",
          values: [value("on", "On"), value("off", "Off")],
        },
      ]}
      provider="copilot"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Allow All" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("allow_all", "on");
});

it("shows Allow All inside the mode popup when both options exist", () => {
  const onChange = vi.fn();
  render(
    <ConfigPickers
      config={[
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          description: null,
          current: "agent",
          via: "option",
          values: [value("agent", "Agent"), value("plan", "Plan"), value("autopilot", "Autopilot")],
        },
        {
          id: "allow_all",
          name: "Allow All",
          category: "permissions",
          description: null,
          current: "off",
          via: "option",
          values: [value("on", "On"), value("off", "Off")],
        },
      ]}
      provider="copilot"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Mode" }));
  fireEvent.click(screen.getByRole("option", { name: "Plan" }));
  expect(onChange).toHaveBeenNthCalledWith(1, "mode", "plan");
  fireEvent.click(screen.getByRole("button", { name: "Mode" }));
  fireEvent.click(screen.getByRole("switch", { name: "Allow All" }));
  expect(onChange).toHaveBeenNthCalledWith(2, "allow_all", "on");
});

it("sends the complete nested model id through ConfigPickers", () => {
  const onChange = vi.fn();
  render(<ConfigPickers config={[config([value("9router/cmc/Beam")])]} provider="copilot" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Beamcmc/Beam" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("model", "9router/cmc/Beam");
});

it("edits secondary settings from the compact popup and restores focus when dismissed", () => {
  const approval: AgentConfigOption = {
    id: "approvals",
    name: "Approvals",
    category: "approval",
    description: null,
    current: "ask",
    via: "option",
    values: [value("ask", "Ask first"), value("bypass", "Bypass approvals")],
  };
  const onChange = vi.fn();
  render(<ConfigPickers config={[approval]} values={{ approvals: "bypass" }} provider="copilot" onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Agent settings" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Agent settings" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Approvals" }));
  fireEvent.click(screen.getByRole("option", { name: "Ask first" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("approvals", "ask");
  expect(dialog).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Agent settings" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

describe("model and effort button", () => {
  const copilotConfig = (effortLevels: string[] | null = ["low", "medium", "high", "xhigh"]): AgentConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: "claude-sonnet-5.5",
      via: "option",
      values: [value("claude-sonnet-5.5", "Claude Sonnet 5.5", "1x"), value("gpt-6-sol", "GPT-6 Sol", "1x")],
    },
    ...(effortLevels
      ? [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            description: null,
            current: "medium",
            via: "option" as const,
            values: effortLevels.map((lvl) => value(lvl, lvl === "xhigh" ? "XHigh" : lvl)),
          },
        ]
      : []),
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      description: null,
      current: "https://agentclientprotocol.com/protocol/session-modes#agent",
      via: "option",
      values: [
        value("https://agentclientprotocol.com/protocol/session-modes#agent", "Agent"),
        value("https://agentclientprotocol.com/protocol/session-modes#plan", "Plan"),
      ],
    },
    {
      id: "allow_all",
      name: "Allow All",
      category: "permissions",
      description: null,
      current: "on",
      via: "option",
      values: [value("on", "On"), value("off", "Off")],
    },
  ];

  it("shows the model with the agent's effort name and the mode with Allow All", () => {
    render(<ConfigPickers config={copilotConfig()} provider="copilot" onChange={vi.fn()} />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model).toHaveTextContent("Claude Sonnet 5.5medium");
    expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("AgentAllow All");
    expect(screen.queryByRole("button", { name: "Reasoning Effort" })).not.toBeInTheDocument();
  });

  it("steps through the advertised effort levels and picks a model from the popup", () => {
    const onChange = vi.fn();
    render(
      <ConfigPickers
        config={copilotConfig()}
        values={{ reasoning_effort: "high" }}
        provider="copilot"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog", { name: "Model & effort settings" });
    const slider = within(dialog).getByRole("slider", { name: "Reasoning Effort" });
    expect(slider).toHaveAttribute("max", "3");
    expect(slider).toHaveValue("2");
    expect(slider).toHaveAttribute("aria-valuetext", "high");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith("reasoning_effort", "xhigh");
    fireEvent.click(within(dialog).getByRole("button", { name: "GPT-6 Sol1x" }));
    expect(onChange).toHaveBeenLastCalledWith("model", "gpt-6-sol");
  });

  it("renders the shooting-star field only at the max effort level", () => {
    const onChange = vi.fn();
    // jsdom has no 2d context; keep it quiet and exercise the no-context path.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { rerender } = render(
      <ConfigPickers
        config={copilotConfig()}
        values={{ reasoning_effort: "high" }}
        provider="copilot"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog", { name: "Model & effort settings" });
    expect(within(dialog).getByRole("slider", { name: "Reasoning Effort" })).toHaveAttribute("aria-valuetext", "high");
    expect(dialog.querySelector("canvas")).not.toBeInTheDocument();
    rerender(
      <ConfigPickers
        config={copilotConfig()}
        values={{ reasoning_effort: "xhigh" }}
        provider="copilot"
        onChange={onChange}
      />,
    );
    expect(dialog.querySelector("canvas")).toBeInTheDocument();
    getContext.mockRestore();
  });

  it("keeps a plain model picker when the agent has no effort option", () => {
    render(<ConfigPickers config={copilotConfig(null)} provider="copilot" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-haspopup", "listbox");
  });
});

describe("model favorites and recents", () => {
  const copilotConfig = (): AgentConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: "sonnet",
      via: "option",
      values: [
        { value: "sonnet", name: "Sonnet", description: null },
        { value: "opus", name: "Opus", description: null },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      description: null,
      current: "low",
      via: "option",
      values: [
        { value: "low", name: "Low", description: null },
        { value: "high", name: "High", description: null },
      ],
    },
  ];
  beforeEach(() => {
    useAgents.setState({ modelFavorites: [], modelRecents: [] });
    globalThis.localStorage?.clear();
  });
  const openPopup = (onChange = vi.fn()) => {
    render(<ConfigPickers config={copilotConfig()} provider="copilot" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    return { onChange, dialog: screen.getByRole("dialog", { name: "Model & effort settings" }) };
  };

  it("stars the current config and applies it back with its effort", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ConfigPickers
        config={copilotConfig()}
        values={{ reasoning_effort: "high" }}
        provider="copilot"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog", { name: "Model & effort settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to favorites: Opus" }));
    expect(within(dialog).getByText("Favorites")).toBeInTheDocument();
    // The favorite carries "high"; switching to "low" first proves applying restores it.
    rerender(
      <ConfigPickers
        config={copilotConfig()}
        values={{ reasoning_effort: "low" }}
        provider="copilot"
        onChange={onChange}
      />,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Opus · High" }));
    expect(onChange).toHaveBeenNthCalledWith(1, "model", "opus");
    expect(onChange).toHaveBeenNthCalledWith(2, "reasoning_effort", "high");
  });

  it("unstars from the favorites section", () => {
    const { dialog } = openPopup();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to favorites: Opus" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from favorites" }));
    expect(within(dialog).queryByText("Favorites")).not.toBeInTheDocument();
  });

  it("records applied models as recents for the same provider only", () => {
    const { onChange } = openPopup();
    const dialog = screen.getByRole("dialog", { name: "Model & effort settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Opus" }));
    expect(onChange).toHaveBeenCalledWith("model", "opus");
    // Applying closes the popup; reopening shows the recorded recent.
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(
      within(screen.getByRole("dialog", { name: "Model & effort settings" })).getByText("Recent"),
    ).toBeInTheDocument();
  });

  it("filters the model list by the search field", () => {
    const { dialog } = openPopup();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search models" }), { target: { value: "opu" } });
    expect(within(dialog).queryByRole("button", { name: "Sonnet" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Opus" })).toBeInTheDocument();
  });
});
