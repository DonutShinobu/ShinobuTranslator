enable f16;

      struct Uniforms { dim_a_outer:i32, dim_b_outer:i32, dim_inner:i32, pad:vec2<i32>, stride:vec2<i32>, dilation:vec2<i32>, x_shape:vec4<u32>, x_strides:vec4<u32>, w_shape:vec4<u32>, w_strides:vec4<u32>, bias_shape:u32, bias_strides:u32, result_shape:vec4<u32>, result_strides:vec4<u32> };
      @group(0) @binding(4) var<uniform> uniforms: Uniforms;





fn getIndexFromCoords4D(coords : vec4<i32>, shape : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
      shape.y * shape.z * shape.w, shape.z * shape.w, shape.w, 1));
}
fn getOutputIndexFromCoords(coords : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
    i32(uniforms.result_strides.x), i32(uniforms.result_strides.y), i32(uniforms.result_strides.z), 1));
}

        //struct Uniforms { xShape : vec4<i32>, wShape : vec4<i32>, outShape : vec4<i32>,
        //  outShapeStrides: vec3<i32>, filterDims : vec2<i32>, pad : vec2<i32>, stride : vec2<i32>,
        //  dilation : vec2<i32>, dimAOuter : i32, dimBOuter : i32, dimInner : i32 };
        @group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;

      fn setOutputAtIndex(flatIndex : i32, value : f32) {
        result[flatIndex] = f32(value);
      }
      fn setOutputAtCoords(d0 : i32, d1 : i32, d2 : i32, d3 : i32, value : f32) {
        let flatIndex = getOutputIndexFromCoords(vec4<i32>(d0, d1, d2, d3));
        setOutputAtIndex(flatIndex , value);
      }
        fn getBiasByOutputCoords(coords : vec4<i32>) -> f32 {
          return bias[coords.w];
        }

    fn mm_readA(batch: i32, row : i32, colIn : i32) -> f32 {

    let col = colIn * 1;

    let inChannels = i32(uniforms.w_shape[2]);
    let outWidth = i32(uniforms.result_shape[2]);
    let outRow = row / outWidth;
    let outCol = row % outWidth;

    let WRow = col / (i32(uniforms.w_shape[1]) * inChannels);
    let WCol = col / inChannels % i32(uniforms.w_shape[1]);
    let xRow = outRow * uniforms.stride[0] + uniforms.dilation[0] * WRow - uniforms.pad[0];
    let xCol = outCol * uniforms.stride[1] + uniforms.dilation[1] * WCol - uniforms.pad[1];
    let xCh = col % inChannels;
    var resData = f32(0.0);
    // The bounds checking is always needed since we use it to pad zero for
    // the 'same' padding type.
    if (xRow >= 0 && xRow < i32(uniforms.x_shape[1]) && xCol >= 0 && xCol < i32(uniforms.x_shape[2])) {

    let coord = vec4<i32>(batch, xRow, xCol, xCh);

      let xIndex = getIndexFromCoords4D(coord, vec4<i32>(uniforms.x_shape));
      resData = x[xIndex];
    }
    return resData;
    }

    fn mm_readB(batch: i32, row : i32, colIn : i32) -> f32 {

    let col = colIn * 1;
    if (row < uniforms.dim_inner && col < uniforms.dim_b_outer) {
      return w[row * i32(uniforms.w_shape[3]) + colIn];
    }
    return f32(0.0);
    }

    fn mm_write(batch: i32, row : i32, colIn : i32, valueIn : f32) {
      let col = colIn * 1;
      if (row < uniforms.dim_a_outer && col < uniforms.dim_b_outer)
      {
      var value = valueIn;
      let outWidth = i32(uniforms.result_shape[2]);

    let coords = vec4<i32>(
      batch,
      row / outWidth,
      row % outWidth,
      col);


      value = value + getBiasByOutputCoords(coords);

      value = (f32(1.0) / (f32(1.0) + exp(-value)));
      setOutputAtCoords(coords[0], coords[1], coords[2], coords[3], value);
      }
    }


  var<workgroup> mm_Asub : array<array<f32, 8>, 32>;
  var<workgroup> mm_Bsub : array<array<f32, 32>, 8>;
  const rowPerThread = 4;
  const colPerThread = 4;
  const tileInner = 8;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
    let batch = i32(globalId.z);

    let num_tiles = (uniforms.dim_inner - 1) / tileInner + 1;
    var kStart = 0;

    var acc : array<array<f32, colPerThread>, rowPerThread>;

    let localRow = i32(localId.y);
    let localCol = i32(localId.x);
    let globalRowStart = i32(workgroupId.y) * 32;
    let globalColStart = i32(workgroupId.x) * 32;

    // Loop over shared dimension.
    for (var t = 0; t < num_tiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var inputRow = localRow; inputRow < 32; inputRow = inputRow + 8) {
        for (var inputCol = localCol; inputCol < 8; inputCol = inputCol + 8) {

            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              globalRowStart + inputRow,
              kStart + inputCol);

        }
      }
      // Load one tile of B into local memory.
      for (var inputRow = localRow; inputRow < 8; inputRow = inputRow + 8) {
            for (var inputCol = localCol; inputCol < 32; inputCol = inputCol + 8) {
          mm_Bsub[inputRow][inputCol] = mm_readB(batch,
            kStart + inputRow,
            globalColStart + inputCol);
        }
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      var BCached : array<f32, colPerThread>;
      for (var k = 0; k < tileInner; k = k + 1) {
        for (var inner = 0; inner < colPerThread; inner = inner + 1) {
          BCached[inner] = mm_Bsub[k][localCol + inner * 8];
        }
        for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let ACached = mm_Asub[localRow + innerRow * 8][k];
          for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
            acc[innerRow][innerCol] = acc[innerRow][innerCol] +
                ACached * BCached[innerCol];
          }
        }
      }
      workgroupBarrier();
    }
    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      let gRow = globalRowStart + localRow + innerRow * 8;
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        let gCol = globalColStart + localCol + innerCol * 8;
        mm_write(batch, gRow, gCol, acc[innerRow][innerCol]);
      }
    }

  }
