import React, { useMemo } from 'react';
import { 
  Wallet, 
  TrendingUp, 
  TrendingDown, 
  ShieldCheck, 
  AlertTriangle, 
  ArrowUpRight, 
  PiggyBank 
} from 'lucide-react';
import { AppData, MarketQuote } from '../types';
import { formatCurrency, calculateFixedIncomeYield } from '../utils';

interface DashboardSummaryProps {
  data: AppData;
  quotes: MarketQuote[];
  rates: { CDI: number; SELIC: number; IPCA: number };
  onTabChange: (tab: string) => void;
}

export default function DashboardSummary({ data, quotes, rates, onTabChange }: DashboardSummaryProps) {
  const totalVariableIncome = useMemo(() => {
    return data.investments.reduce((sum, inv) => {
      const currentQuote = quotes.find(q => q.ticker.toUpperCase() === inv.ticker.toUpperCase());
      const price = currentQuote ? currentQuote.price : inv.purchasePrice;
      // Simple multi-currency handle (USD to BRL rate simulated at ~5.50)
      const conversion = inv.currency === 'USD' ? 5.50 : inv.currency === 'EUR' ? 6.00 : 1.0;
      return sum + (inv.quantity * price * conversion);
    }, 0);
  }, [data.investments, quotes]);

  const totalFixedIncome = useMemo(() => {
    return data.fixedIncome.reduce((sum, inv) => {
      if (inv.actualBalance !== undefined && inv.actualBalance !== null && inv.actualBalance > 0) {
        return sum + inv.actualBalance;
      }
      const calculation = calculateFixedIncomeYield(
        inv.value,
        inv.rate,
        inv.indexation,
        inv.applicationDate,
        new Date(),
        rates
      );
      return sum + calculation.netValue;
    }, 0);
  }, [data.fixedIncome, rates]);

  // Calculation of Saldo: Entradas (Receitas) - Saídas (Despesas)
  const calculatedSaldo = useMemo(() => {
    // 1. Entradas (receitas)
    const totalReceitas = data.transactions
      .filter(t => t.type === 'receita')
      .reduce((sum, t) => {
        const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
        return sum + (t.amount * conv);
      }, 0);

    // 2. Saídas (despesas)
    const totalDespesas = data.transactions
      .filter(t => t.type === 'despesa')
      .reduce((sum, t) => {
        const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
        return sum + (t.amount * conv);
      }, 0);

    return totalReceitas - totalDespesas;
  }, [data.transactions]);

  const bankAccountsBalance = useMemo(() => {
    return data.bankAccounts?.reduce((sum, acc) => sum + acc.balance, 0) || 0;
  }, [data.bankAccounts]);

  const totalCashBalance = useMemo(() => {
    return calculatedSaldo + bankAccountsBalance;
  }, [calculatedSaldo, bankAccountsBalance]);

  const totalNetWorth = useMemo(() => {
    return totalCashBalance + totalVariableIncome + totalFixedIncome;
  }, [totalCashBalance, totalVariableIncome, totalFixedIncome]);

  // Expenses and Income this month
  const monthlyExpenses = useMemo(() => {
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    return data.transactions
      .filter(t => {
        const d = new Date(t.date);
        return t.type === 'despesa' && d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, t) => {
        const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
        return sum + (t.amount * conv);
      }, 0);
  }, [data.transactions]);

  const monthlyIncome = useMemo(() => {
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    return data.transactions
      .filter(t => {
        const d = new Date(t.date);
        return t.type === 'receita' && d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, t) => {
        const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
        return sum + (t.amount * conv);
      }, 0);
  }, [data.transactions]);

  // Budget Status & Alerts
  const budgetAlerts = useMemo(() => {
    const categoriesSpend: Record<string, number> = {};
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    data.transactions
      .filter(t => {
        const d = new Date(t.date);
        return t.type === 'despesa' && d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .forEach(t => {
        const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
        categoriesSpend[t.category] = (categoriesSpend[t.category] || 0) + (t.amount * conv);
      });

    const alerts: Array<{ category: string; spend: number; limit: number; pct: number }> = [];
    Object.keys(data.budgets).forEach(cat => {
      const limit = data.budgets[cat];
      const spend = categoriesSpend[cat] || 0;
      const pct = limit > 0 ? (spend / limit) * 100 : 0;
      if (pct >= 80) {
        alerts.push({ category: cat, spend, limit, pct });
      }
    });
    return alerts;
  }, [data.transactions, data.budgets]);

  return (
    <div id="dashboard-summary" className="space-y-8 animate-fade-in">
      {/* Greetings & Top Level Summary */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 bg-linear-to-b from-neutral-900 to-neutral-950 border border-neutral-800 rounded-2xl text-white shadow-xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-display">Olá, {data.profile.name} 👋</h1>
          <p className="text-neutral-400 text-xs mt-1">Bem-vindo ao seu painel financeiro consolidado inteligente.</p>
        </div>
        <div className="text-left md:text-right">
          <span className="text-[10px] text-neutral-400 uppercase tracking-widest font-mono font-semibold">Patrimônio Líquido Estimado</span>
          <div className="text-3xl font-bold mt-1 text-emerald-400 font-mono tracking-tight">
            {formatCurrency(totalNetWorth, data.profile.currency)}
          </div>
        </div>
      </div>

      {/* Grid Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Card 1: Saldo Atual (Consolidado) */}
        <div 
          id="card-balance" 
          onClick={() => onTabChange('expenses')}
          className="bg-neutral-900/40 hover:bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700/80 p-6 rounded-2xl shadow-xs hover:shadow-[0_4px_25px_rgba(0,0,0,0.5)] transition-all duration-300 cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Saldo Atual</span>
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-bold text-white font-mono tracking-tight">
              {formatCurrency(totalNetWorth, data.profile.currency)}
            </h3>
            <p className="text-xs text-emerald-400 font-medium flex items-center gap-1 mt-2 font-mono">
              <ArrowUpRight className="w-3.5 h-3.5" />
              Soma: Caixa + Renda Fixa + Renda Variável
            </p>
          </div>
        </div>

        {/* Card 2: Renda Variável */}
        <div 
          id="card-investments" 
          onClick={() => onTabChange('investments')}
          className="bg-neutral-900/40 hover:bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700/80 p-6 rounded-2xl shadow-xs hover:shadow-[0_4px_25px_rgba(0,0,0,0.5)] transition-all duration-300 cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Renda Variável</span>
            <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400 group-hover:bg-blue-500/20 transition-colors">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-bold text-white font-mono tracking-tight">
              {formatCurrency(totalVariableIncome, data.profile.currency)}
            </h3>
            <p className="text-xs text-blue-400 font-medium flex items-center gap-1 mt-2 font-mono">
              <TrendingUp className="w-3.5 h-3.5" />
              Monitoramento ativo
            </p>
          </div>
        </div>

        {/* Card 3: Renda Fixa */}
        <div 
          id="card-fixed-income" 
          onClick={() => onTabChange('fixedincome')}
          className="bg-neutral-900/40 hover:bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700/80 p-6 rounded-2xl shadow-xs hover:shadow-[0_4px_25px_rgba(0,0,0,0.5)] transition-all duration-300 cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Renda Fixa</span>
            <div className="p-2.5 bg-purple-500/10 border border-purple-500/20 rounded-xl text-purple-400 group-hover:bg-purple-500/20 transition-colors">
              <PiggyBank className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-bold text-white font-mono tracking-tight">
              {formatCurrency(totalFixedIncome, data.profile.currency)}
            </h3>
            <p className="text-xs text-purple-400 font-medium flex items-center gap-1 mt-2 font-mono">
              <ShieldCheck className="w-3.5 h-3.5" />
              Rendimento líquido projetado
            </p>
          </div>
        </div>

        {/* Card 4: Fluxo de Caixa Mensal */}
        <div 
          id="card-monthly-flow" 
          onClick={() => onTabChange('expenses')}
          className="bg-neutral-900/40 hover:bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700/80 p-6 rounded-2xl shadow-xs hover:shadow-[0_4px_25px_rgba(0,0,0,0.5)] transition-all duration-300 cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Gasto Mensal (BRL)</span>
            <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 group-hover:bg-rose-500/20 transition-colors">
              <TrendingDown className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-bold text-white font-mono tracking-tight">
              {formatCurrency(monthlyExpenses, 'BRL')}
            </h3>
            <div className="mt-2 text-xs flex justify-between text-neutral-400 font-mono">
              <span>Receitas: {formatCurrency(monthlyIncome, 'BRL')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Middle Grid - Budget Limits & Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Side: Orçamento Mensal Limits */}
        <div className="lg:col-span-2 bg-neutral-900/40 border border-neutral-800/80 p-6 rounded-2xl shadow-xs space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-base font-bold text-white font-display">Orçamentos Ativos (Mês Corrente)</h2>
              <p className="text-neutral-400 text-xs mt-0.5">Gastos acumulados comparados ao limite estabelecido</p>
            </div>
            <button 
              onClick={() => onTabChange('expenses')}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 cursor-pointer"
            >
              Configurar Limites
            </button>
          </div>

          <div className="space-y-5">
            {Object.keys(data.budgets).map(category => {
              const limit = data.budgets[category];
              // Calculate spend in BRL
              const today = new Date();
              const currentMonth = today.getMonth();
              const currentYear = today.getFullYear();

              const spend = data.transactions
                .filter(t => {
                  const d = new Date(t.date);
                  return t.category === category && t.type === 'despesa' && d.getMonth() === currentMonth && d.getFullYear() === currentYear;
                })
                .reduce((sum, t) => {
                  const conv = t.currency === 'USD' ? 5.50 : t.currency === 'EUR' ? 6.00 : 1.0;
                  return sum + (t.amount * conv);
                }, 0);

              const percent = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0;
              const isOver = spend > limit;
              const isWarning = percent >= 80 && percent < 100;

              return (
                <div key={category} className="space-y-1.5">
                  <div className="flex justify-between text-xs font-medium text-neutral-300">
                    <span className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isOver ? 'bg-rose-500 animate-pulse' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      {category}
                    </span>
                    <span className="font-mono text-xs">
                      {formatCurrency(spend, 'BRL')} / <span className="text-neutral-500">{formatCurrency(limit, 'BRL')}</span>
                    </span>
                  </div>
                  <div className="h-2 w-full bg-neutral-800 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side: Alerts Panel */}
        <div className="bg-neutral-900/40 border border-neutral-800/80 p-6 rounded-2xl shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 border-b border-neutral-800 pb-4 mb-4">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h2 className="text-base font-bold text-white font-display">Alertas de Limite</h2>
            </div>

            {budgetAlerts.length === 0 ? (
              <div className="text-center py-10">
                <ShieldCheck className="w-10 h-10 text-emerald-500/20 mx-auto mb-3" />
                <p className="text-neutral-300 font-semibold text-sm">Tudo sob controle!</p>
                <p className="text-neutral-500 text-xs mt-1">Nenhum orçamento ultrapassou 80% do limite.</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                {budgetAlerts.map(alert => (
                  <div 
                    key={alert.category}
                    className={`p-3.5 rounded-xl border text-xs ${alert.pct >= 100 ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' : 'bg-amber-500/10 border-amber-500/20 text-amber-300'}`}
                  >
                    <div className="flex justify-between font-bold">
                      <span>{alert.category}</span>
                      <span className="font-mono">{alert.pct.toFixed(0)}%</span>
                    </div>
                    <p className="text-[11px] mt-1 text-neutral-400">
                      {alert.pct >= 100 
                        ? `Atenção: Você estourou seu limite em ${formatCurrency(alert.spend - alert.limit, 'BRL')}.`
                        : `Alerta: Gasto atual de ${formatCurrency(alert.spend, 'BRL')} está próximo do limite de ${formatCurrency(alert.limit, 'BRL')}.`
                      }
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-neutral-800 bg-neutral-950/40 p-3.5 rounded-xl text-center">
            <span className="text-[10px] text-emerald-400 font-bold block uppercase tracking-wider mb-1 font-mono">Dica Financeira Inteligente</span>
            <p className="text-neutral-400 text-xs leading-relaxed">
              Utilize o **Scanner de Recibos IA** para escanear recibos de gastos físicos e lançar de forma ágil e inteligente, evitando furos no orçamento!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
