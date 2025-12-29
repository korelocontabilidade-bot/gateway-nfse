const express = require("express");
const app = express();

app.get("/nfse/distribuicao", (req, res) => {
  const nsu = Number(req.query.nsu || 0);

  res.json({
    StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO",
    ultimoNSU: nsu,
    LoteDFe: []
  });
});

app.listen(3000, () => {
  console.log("Gateway NFSe rodando");
});
