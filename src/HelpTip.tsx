type HelpTipProps = {
  text: string
  tone?: 'help' | 'warning'
  label?: string
  placement?: 'top' | 'bottom'
}

export function HelpTip({text,tone='help',label,placement='top'}:HelpTipProps) {
  const symbol=tone==='warning'?'!':'?'
  return <span
    className={`help-tip help-tip-${tone} help-tip-${placement}`}
    tabIndex={0}
    role="button"
    aria-label={label||`${tone==='warning'?'Atenção':'Ajuda'}: ${text}`}
  >
    <span className="help-tip-symbol" aria-hidden="true">{symbol}</span>
    <span className="help-tip-bubble" role="tooltip">{text}</span>
  </span>
}

export function FieldLabel({children,help,warning}:{children:React.ReactNode;help:string;warning?:boolean}) {
  return <span className="field-label"><span>{children}</span><HelpTip text={help} tone={warning?'warning':'help'}/></span>
}
